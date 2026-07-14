/**
 * Cost ledger — real-time usage metering.
 *
 * Every LLM call and every metered (tier-1) plugin call writes a `usage_events`
 * row with what WE pay (costUsd) and what the client is charged (billedUsd).
 * That gives per-workspace margin in real time and makes hard caps enforceable
 * BEFORE the next call runs.
 *
 * LLM costs are exact: Bedrock/Anthropic return token counts in every response,
 * so we meter in-band rather than scraping AWS bills after the fact.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { tenants, usageEvents } from '@/models/Schema';

/** USD per 1M tokens. Keep in sync with provider pricing. */
type ModelPrice = { input: number; output: number; cacheRead: number };

const MODEL_PRICES: Record<string, ModelPrice> = {
  // Claude Sonnet class
  'sonnet': { input: 3, output: 15, cacheRead: 0.30 },
  // Claude Haiku class
  'haiku': { input: 0.80, output: 4, cacheRead: 0.08 },
  // Claude Opus class
  'opus': { input: 15, output: 75, cacheRead: 1.50 },
};

/** Markup applied to raw provider cost when billing the client. */
export const DEFAULT_MARKUP = Number(process.env.BILLING_MARKUP || '1.5');

function priceForModel(modelId: string): ModelPrice {
  const id = modelId.toLowerCase();
  if (id.includes('haiku')) {
    return MODEL_PRICES.haiku!;
  }
  if (id.includes('opus')) {
    return MODEL_PRICES.opus!;
  }
  return MODEL_PRICES.sonnet!;
}

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Read from the prompt cache — ~10% of the input price. */
  cacheReadTokens?: number;
  /** Written to the prompt cache — 1.25x the input price (a one-off premium). */
  cacheWriteTokens?: number;
};

/** Cache writes carry a 25% premium over normal input tokens. */
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Cost in USD of a single LLM call, from its actual token counts. */
export function llmCostUsd(modelId: string, usage: TokenUsage): number {
  const p = priceForModel(modelId);
  return (
    (usage.inputTokens / 1_000_000) * p.input
    + (usage.outputTokens / 1_000_000) * p.output
    + ((usage.cacheReadTokens ?? 0) / 1_000_000) * p.cacheRead
    + ((usage.cacheWriteTokens ?? 0) / 1_000_000) * p.input * CACHE_WRITE_MULTIPLIER
  );
}

/** Record an LLM call. Never throws — metering must not break the agent. */
export async function meterLlm(a: {
  tenantId: string;
  modelId: string;
  usage: TokenUsage;
  detail?: string;
}): Promise<void> {
  try {
    const cost = llmCostUsd(a.modelId, a.usage);
    await db.insert(usageEvents).values({
      tenantId: a.tenantId,
      kind: 'llm',
      source: a.modelId.slice(0, 120),
      detail: a.detail?.slice(0, 160),
      inputTokens: a.usage.inputTokens,
      outputTokens: a.usage.outputTokens,
      cacheReadTokens: a.usage.cacheReadTokens ?? 0,
      costUsd: cost.toFixed(6),
      billedUsd: (cost * DEFAULT_MARKUP).toFixed(6),
    });
  } catch {
    // ledger failures must never break a conversation
  }
}

/**
 * Price rule for a tier-1 plugin tool:
 *   { unit: 'call',  costUsd: 0.002 }                       → per call
 *   { unit: 'arg',   argField: 'seconds', costUsd: 0.05 }   → cost × arg value
 *   { unit: 'usage', costUsd: 0.005 }                       → cost × units the
 *       PROVIDER reports it actually consumed (Kie.ai returns `creditsConsumed`
 *       on every task, at a flat $0.005/credit). This is exact for all 368+ Kie
 *       models — image, video, music, chat — and never goes stale when they add
 *       a model or change a price. No price table to maintain.
 */
export type PriceRule = {
  unit: 'call' | 'arg' | 'usage';
  argField?: string;
  costUsd: number;
  markup?: number;
};

export function pluginCostUsd(
  rule: PriceRule,
  args: Record<string, unknown>,
  reportedUnits?: number,
): { cost: number; quantity: number } {
  if (rule.unit === 'usage') {
    const q = Math.max(Number(reportedUnits) || 0, 0);
    return { cost: rule.costUsd * q, quantity: q };
  }
  if (rule.unit === 'arg' && rule.argField) {
    const q = Math.max(Number(args[rule.argField]) || 0, 0);
    return { cost: rule.costUsd * q, quantity: q };
  }
  return { cost: rule.costUsd, quantity: 1 };
}

/** Record a metered plugin call. Never throws. */
export async function meterPlugin(a: {
  tenantId: string;
  slug: string;
  tool: string;
  rule: PriceRule;
  args: Record<string, unknown>;
  /** Units the provider says it consumed (e.g. Kie credits). */
  reportedUnits?: number;
}): Promise<void> {
  try {
    const { cost, quantity } = pluginCostUsd(a.rule, a.args, a.reportedUnits);
    const markup = a.rule.markup ?? DEFAULT_MARKUP;
    await db.insert(usageEvents).values({
      tenantId: a.tenantId,
      kind: 'plugin',
      source: a.slug.slice(0, 120),
      detail: a.tool.slice(0, 160),
      quantity: quantity.toFixed(4),
      costUsd: cost.toFixed(6),
      billedUsd: (cost * markup).toFixed(6),
    });
  } catch {
    // ignore
  }
}

// ─── Spend guardrails ────────────────────────────────────────────────────────

export type SpendStatus = {
  allowed: boolean;
  reason?: string;
  todayCostUsd: number;
  dailyCapUsd: number;
  monthCostUsd: number;
  monthBilledUsd: number;
  monthlyBudgetUsd: number;
  paused: boolean;
};

function startOfToday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

async function sumCost(tenantId: string, since: Date): Promise<{ cost: number; billed: number }> {
  const [row] = await db
    .select({
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)`,
      billed: sql<string>`coalesce(sum(${usageEvents.billedUsd}), 0)`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.tenantId, tenantId), gte(usageEvents.at, since)));
  return { cost: Number(row?.cost ?? 0), billed: Number(row?.billed ?? 0) };
}

/**
 * Checked BEFORE every agent turn and before every metered plugin call.
 * Blocks on: workspace paused (kill switch) or daily cost cap reached.
 */
export async function checkSpend(tenantId: string): Promise<SpendStatus> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const dailyCapUsd = Number(tenant?.dailyCapUsd ?? 10);
  const monthlyBudgetUsd = Number(tenant?.monthlyBudgetUsd ?? 50);
  const paused = Boolean(tenant?.paused);

  const today = await sumCost(tenantId, startOfToday());
  const month = await sumCost(tenantId, startOfMonth());

  const base: SpendStatus = {
    allowed: true,
    todayCostUsd: today.cost,
    dailyCapUsd,
    monthCostUsd: month.cost,
    monthBilledUsd: month.billed,
    monthlyBudgetUsd,
    paused,
  };

  if (paused) {
    return { ...base, allowed: false, reason: 'This workspace is paused by the platform administrator.' };
  }
  if (dailyCapUsd > 0 && today.cost >= dailyCapUsd) {
    return {
      ...base,
      allowed: false,
      reason: `Daily spend cap reached ($${today.cost.toFixed(2)} of $${dailyCapUsd.toFixed(2)}). It resets at 00:00 UTC, or an admin can raise the cap.`,
    };
  }
  return base;
}
