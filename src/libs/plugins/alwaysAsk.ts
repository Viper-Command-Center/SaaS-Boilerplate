/**
 * `alwaysAsk` — the one rule, in one pure function (Phase 49).
 *
 * A provider lists the tools that reach real people or cannot be undone
 * (BuiltinProvider.alwaysAsk). For those tools the connection-wide "Auto-run"
 * switch becomes "Ask first" — and nothing else changes. It can only TIGHTEN:
 * Ask stays Ask, and Blocked stays Blocked, so a provider can never loosen what
 * a workspace chose.
 *
 * Kept out of registry.ts so the rule can be unit-tested without importing the
 * database, the vault and every provider.
 */

import type { ToolPolicy } from '@/libs/mcp/registry';

export function applyAlwaysAsk(
  policy: ToolPolicy,
  alwaysAsk: readonly string[] | undefined,
  toolName: string,
): ToolPolicy {
  return policy === 'auto' && alwaysAsk?.includes(toolName) ? 'approval' : policy;
}
