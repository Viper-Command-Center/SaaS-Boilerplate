/**
 * Built-in providers — in-app adapters for services with NO hosted MCP server.
 *
 * Two shapes:
 *  1. Platform-owned (tier 1, e.g. Kie.ai): OUR key on the catalog entry,
 *     metered per call and billed to the workspace.
 *  2. Per-connection (e.g. WordPress): each workspace supplies its OWN target
 *     (site URL) and credential. Set `perConnection: true`.
 *
 * Vendors that DO publish a hosted MCP (GitHub, Duda…) are registered as plain
 * HTTP connections instead — no code required.
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
  /** What the admin (tier 1) or the client (perConnection) pastes. */
  credentialLabel: string;
  /**
   * True = the credential and target live on the workspace's connection, not
   * on the catalog entry (each client has their own site/account).
   */
  perConnection?: boolean;
  tools: BuiltinTool[];
  /**
   * Execute one tool.
   *  credential — decrypted key (platform's, or the workspace's)
   *  target     — per-connection target, e.g. the WordPress site URL
   */
  call: (
    tool: string,
    args: Record<string, unknown>,
    credential: string,
    target?: string,
  ) => Promise<string>;
};
