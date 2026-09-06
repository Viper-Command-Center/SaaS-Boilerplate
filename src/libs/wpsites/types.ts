/**
 * WordPress Sites connector (Phase 34) — shared types.
 *
 * One workspace holds N WordPress sites. Each site carries every channel the
 * platform knows how to speak to WordPress with:
 *   rest — the core REST API (+ the artivio-wp-agent base plugin's namespace)
 *   mcp  — a site-hosted MCP endpoint (Oxygen Agent Connector, the WordPress
 *          MCP Adapter, or any plugin that registers an `mcp/…` REST namespace)
 *   cli  — WP-CLI over SSH (ssh2, path-pinned, deny-listed — see wpcli.ts)
 *
 * Nothing here is builder-specific. Oxygen / Divi / Bricks / Elementor are
 * DETECTED capabilities written into `capabilities`, never assumptions.
 */

export type Channel = 'rest' | 'mcp' | 'cli';

/** The per-channel execution policy as the UI shows it. */
export type SitePolicyValue = 'auto' | 'ask' | 'blocked';

export type SitePolicy = Record<Channel, SitePolicyValue>;

export const DEFAULT_SITE_POLICY: SitePolicy = { rest: 'ask', mcp: 'ask', cli: 'ask' };

export type AuthScheme = 'basic' | 'bearer';

export type Builder = 'oxygen' | 'divi' | 'bricks' | 'elementor' | 'gutenberg' | 'none';

export type SiteStatus = 'healthy' | 'degraded' | 'failed' | 'untested';

/** Discovered facts about a site — refreshed by Test, read-only in the UI. */
export type SiteCapabilities = {
  rest: boolean;
  mcp: boolean;
  cli: boolean;
  /** MCP ability names that belong to the detected builder (e.g. oxygen/*). */
  builder_abilities: string[];
  /** Active plugin slugs (from WP-CLI, or the base plugin's /site route). */
  plugins: string[];
  /** Every MCP tool name the endpoint advertised, for the agent's `wp_mcp_tools`. */
  mcp_tools: string[];
  /** REST namespaces the site advertises (wp/v2, artivio/v1, elementor/v1…). */
  namespaces: string[];
  /** Whether the artivio-wp-agent base plugin answered. */
  base_plugin: boolean;
  /** Roles of the agent user, from users/me?context=edit. */
  roles: string[];
};

/** One row of the Test report. */
export type TestRow = {
  check: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
  hint?: string;
};

export type TestReport = {
  status: SiteStatus;
  rows: TestRow[];
  durationMs: number;
  testedAt: string;
};

/**
 * A site with its secrets OPENED — only ever built server-side, inside a call.
 * Never serialised to a response, a log, or a tool result.
 */
export type ResolvedSite = {
  id: string;
  tenantId: string;
  label: string;
  isDefault: boolean;
  siteUrl: string;
  authScheme: AuthScheme;
  authUser: string | null;
  authSecret: string;
  appPasswordUuid: string | null;
  ssh: { host: string; port: number; user: string; path: string; privateKey: string } | null;
  mcpEndpointUrl: string | null;
  builder: Builder | null;
  capabilities: SiteCapabilities;
  policy: SitePolicy;
  status: SiteStatus;
};

/** What leaves the server for the Sites UI: secrets masked, everything else. */
export type PublicSite = {
  id: string;
  label: string;
  isDefault: boolean;
  siteUrl: string;
  authScheme: AuthScheme;
  authUser: string | null;
  /** e.g. "••••••••••••abcd" — the last 4 only. */
  secretMask: string;
  ssh: { host: string; port: number; user: string; path: string; keyId: string | null } | null;
  mcpEndpointUrl: string | null;
  wpVersion: string | null;
  phpVersion: string | null;
  builder: Builder | null;
  builderVersion: string | null;
  agentConnectorVersion: string | null;
  capabilities: SiteCapabilities;
  policy: SitePolicy;
  status: SiteStatus;
  lastTestAt: string | null;
  lastTestReport: TestReport | null;
  createdAt: string;
  updatedAt: string;
};

export const EMPTY_CAPABILITIES: SiteCapabilities = {
  rest: false,
  mcp: false,
  cli: false,
  builder_abilities: [],
  plugins: [],
  mcp_tools: [],
  namespaces: [],
  base_plugin: false,
  roles: [],
};
