/**
 * Built-in providers — in-app adapters for services we RESELL (tier 1).
 *
 * Why in-app rather than an MCP server: a third-party MCP would run on the
 * vendor's terms and never report usage back to us, so we could not meter,
 * cap or bill it. An adapter we own calls the vendor's REST API directly,
 * meters the exact cost in the same transaction, and needs no extra service.
 *
 * Vendors that DO publish a hosted MCP (GitHub, etc.) should be registered as
 * normal HTTP connections instead — no code required.
 */

import type { AnthropicTool } from '@/libs/mcp/registry';

export type BuiltinTool = AnthropicTool & {
  /** Optional: which numeric argument drives per-unit pricing (e.g. seconds). */
  meteredArg?: string;
};

export type BuiltinProvider = {
  slug: string;
  name: string;
  description: string;
  /** What the admin pastes when adding this as a tier-1 plugin. */
  credentialLabel: string;
  tools: BuiltinTool[];
  /** Execute one tool. `apiKey` is the platform credential, decrypted. */
  call: (tool: string, args: Record<string, unknown>, apiKey: string) => Promise<string>;
};
