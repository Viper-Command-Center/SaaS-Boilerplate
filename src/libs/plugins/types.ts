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
  /**
   * An async job that outran our poll window. The provider WILL still bill us
   * when it finishes, so the registry flags this for reconciliation (Issues
   * inbox) rather than recording a silent $0.
   */
  pendingReconcile?: string;
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
  /**
   * 🔴 PHASE 30.1 — what the per-connection TARGET actually is.
   * The connect form used to hardcode "Your site URL — https://yoursite.com"
   * for every perConnection provider and validate it with z.string().url(),
   * because WordPress was the only one and its target IS a site. Google
   * Analytics' target is a numeric GA4 property ID, so the form asked the
   * wrong question AND rejected the right answer — the user could only enter
   * something wrong, and the agent then reported a config error it was blamed
   * for. A form that can create a thing must ask for the thing it needs.
   */
  targetLabel?: string;
  targetPlaceholder?: string;
  /** Default true (a URL). False = free-form, e.g. a numeric property ID. */
  targetIsUrl?: boolean;
  /**
   * 'ssh-key' = the per-connection credential is an SSH private key that the
   * PLATFORM generates (POST /api/plugins/ssh-key) and seals straight into the
   * vault. The Tools panel shows a "Generate SSH key" button and the resulting
   * PUBLIC key for the client to paste into their host; the private half never
   * transits chat, a file or a form. Default (undefined) = a pasted secret.
   */
  credentialKind?: 'ssh-key';
  /**
   * 🔴 PHASE 32 — cross-tool operating notes, injected into the system prompt
   * for every workspace that has this provider enabled.
   *
   * Per-TOOL guidance belongs in that tool's `description`. This is for the
   * rules that span tools and therefore have nowhere else to live: which
   * connection to reach for, which write silently does nothing, what to verify
   * after a change. Elementor is the case that forced it — "typography_font_size
   * is ignored unless typography_typography is 'custom'" is a fact about the
   * PLUGIN, identical on every client site, and it was discovered the expensive
   * way on the first one.
   *
   * It lives here rather than in each workspace's memory on purpose. Copied into
   * N workspaces it would need correcting in N places the next time a provider
   * changes, and stale guidance is worse than none — the Phase 22 failure, where
   * a hand-maintained table drifted and the agent started guessing. Here it is
   * versioned with the adapter it describes, so a fix reaches every site at once.
   *
   * COST: only for connections a workspace actually enabled, and it sits inside
   * the cachedSystem() breakpoint, so repeat calls in a turn read it at ~10%.
   * Keep it to the traps that cost a real debugging session; anything the model
   * would get right anyway is pure overhead. A few hundred tokens, not a manual.
   */
  guidance?: string;
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
    /**
     * Which workspace this call belongs to. Added so a provider can reach the
     * workspace's OWN file library — Postmark attaches a generated deck by file
     * id rather than having the model carry base64 through its context, where a
     * 500KB PDF becomes ~700K characters and blows the window.
     *
     * Optional: providers that never touch tenant storage simply omit it.
     */
    ctx?: { tenantId: string },
  ) => Promise<string | BuiltinResult>;
};
