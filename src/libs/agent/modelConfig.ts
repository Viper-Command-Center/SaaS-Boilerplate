/**
 * Per-workspace AI model assignment (Phase 43, 2026-09-12).
 *
 * Where it's stored: tenants.settings jsonb (an existing, previously-unused
 * column — see Schema.ts) under an `aiModels` key:
 *   { chatModelId, chatReasoningEffort, buildModelId, buildReasoningEffort }
 * Any field can be missing — an unset workspace falls back to the platform
 * defaults below.
 *
 * "chat" vs. "build" context: a real conversationId means an interactive
 * chat turn (cheaper/faster model, less thinking); an empty conversationId
 * means a scheduled task or mission step — real build work, worth paying for
 * more capability. runToolLoop already computes exactly this distinction for
 * billing (`detail: a.conversationId ? 'chat' : 'scheduled'`), so this reuses
 * the same signal rather than inventing a second one.
 */

import type { ReasoningEffort } from '@/libs/agent/anthropic';
import { eq } from 'drizzle-orm';
import { DEFAULT_MANTLE_MODEL } from '@/libs/agent/anthropic';
import { db } from '@/libs/DB';
import { tenants } from '@/models/Schema';

export type ModelContext = 'chat' | 'build';

export type ModelConfig = {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
};

type AiModelsSettings = {
  chatModelId?: string;
  chatReasoningEffort?: ReasoningEffort;
  buildModelId?: string;
  buildReasoningEffort?: ReasoningEffort;
};

/**
 * Platform defaults used when a workspace hasn't picked its own model.
 * Chat: cheap and fast (low thinking). Build: full capability. Both point at
 * Claude Sonnet 5 today — the same model the platform already used for
 * everything, so an unconfigured workspace behaves exactly as before.
 */
export const PLATFORM_DEFAULT_CHAT: ModelConfig = { modelId: DEFAULT_MANTLE_MODEL, reasoningEffort: 'low' };
export const PLATFORM_DEFAULT_BUILD: ModelConfig = { modelId: DEFAULT_MANTLE_MODEL, reasoningEffort: 'high' };

/**
 * Resolve which model + reasoning effort a tenant's call should use. Never
 * throws — a DB hiccup falls back to the platform default rather than
 * failing the whole turn over a model-picker lookup.
 */
export async function resolveModelConfig(tenantId: string, context: ModelContext): Promise<ModelConfig> {
  const fallback = context === 'chat' ? PLATFORM_DEFAULT_CHAT : PLATFORM_DEFAULT_BUILD;
  try {
    const [row] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const ai = (row?.settings as { aiModels?: AiModelsSettings } | null)?.aiModels;
    if (!ai) {
      return fallback;
    }
    if (context === 'chat' && ai.chatModelId) {
      return { modelId: ai.chatModelId, reasoningEffort: ai.chatReasoningEffort ?? fallback.reasoningEffort };
    }
    if (context === 'build' && ai.buildModelId) {
      return { modelId: ai.buildModelId, reasoningEffort: ai.buildReasoningEffort ?? fallback.reasoningEffort };
    }
    return fallback;
  } catch {
    return fallback;
  }
}
