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

/**
 * What a tool call returns. A provider that knows what a call actually cost it
 * (Kie.ai reports `creditsConsumed` on every task) returns `units`, so we bill
 * the exact amount instead of guessing from a price table.
 */
export type BuiltinResult = {
  output: string;
  /** Units the provider consumed (e.g. Kie credits). */
  units?: number;
  /** Media the platform should archive (provider URLs expire). */
  assetUrls?: string[];
};

/**
 * Usage-based metering: the provider reports units, we price them at one flat
 * rate. Beats maintaining a per-model price table that goes stale weekly.
 */
export type UsageMetering = {
  /** e.g. 'credit' */
  unitLabel: string;
  /** Our cost per unit — Kie.ai = $0.005 per credit, flat across all models. */
  defaultUnitCostUsd: number;
  /** Shown in the admin pricing UI. */
  note?: string;
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
  /**
   * True = the platform credential may hold MANY keys (one per line). The
   * adapter round-robins across them and fails over if one is rate-limited,
   * out of credit or blocked.
   */
  multiKey?: boolean;
  /**
   * True = the provider needs NO credential of its own because it authenticates
   * with platform infrastructure already configured (e.g. the AgentCore browser
   * uses the same AWS keys as Bedrock). Nothing for anyone to paste.
   */
  noCredential?: boolean;
  /** Set when the provider reports its own consumption (see UsageMetering). */
  usageMetering?: UsageMetering;
  tools: BuiltinTool[];
  /**
   * Execute one tool.
   *  credential — decrypted key(s) (platform's, or the workspace's)
   *  target     — per-connection target, e.g. the WordPress site URL
   */
  call: (
    tool: string,
    args: Record<string, unknown>,
    credential: string,
    target?: string,
  ) => Promise<string | BuiltinResult>;
};
