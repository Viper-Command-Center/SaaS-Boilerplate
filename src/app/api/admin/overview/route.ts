/**
 * GET /api/admin/overview — platform admin only.
 * Every workspace with this month's cost, billed amount, margin, today's spend
 * against its cap, member count and pause state. This is the profitability view.
 */

import { desc, eq, gte, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { PLATFORM_DEFAULT_BUILD, PLATFORM_DEFAULT_CHAT } from '@/libs/agent/modelConfig';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { memberships, modelCatalog, tenants, usageEvents, users } from '@/models/Schema';

type AiModelsSettings = {
  chatModelId?: string;
  chatReasoningEffort?: string;
  buildModelId?: string;
  buildReasoningEffort?: string;
};

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const allTenants = await db.select().from(tenants).orderBy(desc(tenants.createdAt));

  const monthRows = await db
    .select({
      tenantId: usageEvents.tenantId,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)`,
      billed: sql<string>`coalesce(sum(${usageEvents.billedUsd}), 0)`,
      inTok: sql<string>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      outTok: sql<string>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.at, monthStart))
    .groupBy(usageEvents.tenantId);

  const dayRows = await db
    .select({
      tenantId: usageEvents.tenantId,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.at, dayStart))
    .groupBy(usageEvents.tenantId);

  const memberRows = await db
    .select({ tenantId: memberships.tenantId, n: sql<string>`count(*)` })
    .from(memberships)
    .groupBy(memberships.tenantId);

  const monthBy = new Map(monthRows.map(r => [r.tenantId, r]));
  const dayBy = new Map(dayRows.map(r => [r.tenantId, r]));
  const memBy = new Map(memberRows.map(r => [r.tenantId, Number(r.n)]));

  const workspaces = allTenants.map((t) => {
    const m = monthBy.get(t.id);
    const cost = Number(m?.cost ?? 0);
    const billed = Number(m?.billed ?? 0);
    const ai = (t.settings as { aiModels?: AiModelsSettings } | null)?.aiModels;
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      planName: t.planName,
      paused: t.paused,
      monthlyBudgetUsd: Number(t.monthlyBudgetUsd),
      dailyCapUsd: Number(t.dailyCapUsd),
      members: memBy.get(t.id) ?? 0,
      monthCostUsd: cost,
      monthBilledUsd: billed,
      marginUsd: billed - cost,
      todayCostUsd: Number(dayBy.get(t.id)?.cost ?? 0),
      inputTokens: Number(m?.inTok ?? 0),
      outputTokens: Number(m?.outTok ?? 0),
      // Phase 43 — falls back to the platform default so the UI always shows
      // what a workspace is ACTUALLY using, not a blank picker.
      chatModelId: ai?.chatModelId || PLATFORM_DEFAULT_CHAT.modelId,
      chatReasoningEffort: ai?.chatReasoningEffort || PLATFORM_DEFAULT_CHAT.reasoningEffort,
      buildModelId: ai?.buildModelId || PLATFORM_DEFAULT_BUILD.modelId,
      buildReasoningEffort: ai?.buildReasoningEffort || PLATFORM_DEFAULT_BUILD.reasoningEffort,
    };
  });

  const [{ userCount }] = await db
    .select({ userCount: sql<string>`count(*)` })
    .from(users)
    .where(sql`${users.deletedAt} is null`) as [{ userCount: string }];

  const totals = workspaces.reduce(
    (acc, w) => ({
      cost: acc.cost + w.monthCostUsd,
      billed: acc.billed + w.monthBilledUsd,
      margin: acc.margin + w.marginUsd,
    }),
    { cost: 0, billed: 0, margin: 0 },
  );

  // Active model catalog — the Workspaces tab's Chat/Build model dropdowns
  // are populated from this, not hardcoded, so an admin can add/reprice a
  // model (see /api/admin/models) without a deploy.
  const catalog = await db
    .select()
    .from(modelCatalog)
    .where(eq(modelCatalog.active, true))
    .orderBy(modelCatalog.provider, modelCatalog.displayName);

  return NextResponse.json({
    workspaces,
    totals: { ...totals, users: Number(userCount), workspaces: workspaces.length },
    modelCatalog: catalog,
  });
}

/**
 * PATCH /api/admin/overview — update a workspace's plan, caps, pause state,
 * or AI model assignment.
 *
 * Model fields (chatModelId/buildModelId/chatReasoningEffort/
 * buildReasoningEffort) live inside the `settings` jsonb column, unlike the
 * scalar columns above — jsonb needs a read-then-merge (a blind `.set()`
 * would blow away every OTHER key ever stored in settings), so this does one
 * extra SELECT only when a model field is actually part of the request.
 */
export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  let body: {
    tenantId?: string;
    planName?: string;
    monthlyBudgetUsd?: number;
    dailyCapUsd?: number;
    paused?: boolean;
    chatModelId?: string;
    chatReasoningEffort?: string;
    buildModelId?: string;
    buildReasoningEffort?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  if (!body.tenantId) {
    return NextResponse.json({ error: 'tenantId required.' }, { status: 400 });
  }

  const touchesModels = ['chatModelId', 'chatReasoningEffort', 'buildModelId', 'buildReasoningEffort']
    .some(k => (body as Record<string, unknown>)[k] !== undefined);

  let settingsPatch: Record<string, unknown> | undefined;
  if (touchesModels) {
    const [current] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, body.tenantId)).limit(1);
    const existing = (current?.settings as Record<string, unknown> | null) ?? {};
    const existingAi = (existing.aiModels as Record<string, unknown> | undefined) ?? {};
    settingsPatch = {
      ...existing,
      aiModels: {
        ...existingAi,
        ...(body.chatModelId !== undefined ? { chatModelId: body.chatModelId } : {}),
        ...(body.chatReasoningEffort !== undefined ? { chatReasoningEffort: body.chatReasoningEffort } : {}),
        ...(body.buildModelId !== undefined ? { buildModelId: body.buildModelId } : {}),
        ...(body.buildReasoningEffort !== undefined ? { buildReasoningEffort: body.buildReasoningEffort } : {}),
      },
    };
  }

  await db
    .update(tenants)
    .set({
      ...(body.planName !== undefined ? { planName: String(body.planName).slice(0, 40) } : {}),
      ...(body.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: String(Math.max(0, body.monthlyBudgetUsd)) } : {}),
      ...(body.dailyCapUsd !== undefined ? { dailyCapUsd: String(Math.max(0, body.dailyCapUsd)) } : {}),
      ...(body.paused !== undefined ? { paused: Boolean(body.paused) } : {}),
      ...(settingsPatch !== undefined ? { settings: settingsPatch } : {}),
    })
    .where(eq(tenants.id, body.tenantId));

  return NextResponse.json({ ok: true });
}
