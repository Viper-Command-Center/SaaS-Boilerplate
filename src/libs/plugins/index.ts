/**
 * Registry of built-in providers (services with no hosted MCP server).
 * Adding one = write an adapter here; it appears in the admin catalog's
 * provider dropdown immediately.
 */

import type { BuiltinProvider } from '@/libs/plugins/types';
import { agentcoreBrowserProvider } from '@/libs/plugins/agentcoreBrowser';
import { cloudflareAnalyticsProvider } from '@/libs/plugins/cloudflareAnalytics';
import { googleAnalyticsProvider } from '@/libs/plugins/googleAnalytics';
import { heygenProvider } from '@/libs/plugins/heygen';
import { kieProvider } from '@/libs/plugins/kie';
import { wordpressProvider } from '@/libs/plugins/wordpress';

export const BUILTIN_PROVIDERS: Record<string, BuiltinProvider> = {
  [kieProvider.slug]: kieProvider,
  [wordpressProvider.slug]: wordpressProvider,
  [agentcoreBrowserProvider.slug]: agentcoreBrowserProvider,
  [heygenProvider.slug]: heygenProvider,
  [cloudflareAnalyticsProvider.slug]: cloudflareAnalyticsProvider,
  [googleAnalyticsProvider.slug]: googleAnalyticsProvider,
};

export function getBuiltinProvider(slug: string): BuiltinProvider | undefined {
  return BUILTIN_PROVIDERS[slug];
}

/** For the admin UI: what can be added as a built-in plugin. */
export function listBuiltinProviders() {
  return Object.values(BUILTIN_PROVIDERS).map(p => ({
    slug: p.slug,
    name: p.name,
    description: p.description,
    credentialLabel: p.credentialLabel,
    perConnection: Boolean(p.perConnection),
    multiKey: Boolean(p.multiKey),
    noCredential: Boolean(p.noCredential),
    usageMetering: p.usageMetering ?? null,
    targetLabel: p.targetLabel ?? null,
    targetPlaceholder: p.targetPlaceholder ?? null,
    targetIsUrl: p.targetIsUrl !== false,
    tools: p.tools.map(t => ({
      name: t.name,
      description: t.description,
      meteredArg: t.meteredArg,
    })),
  }));
}

/**
 * Ready-made catalog entries the admin can add in one click. These are just
 * form pre-fills — nothing is hardcoded into the platform.
 */
export const CATALOG_PRESETS = [
  {
    key: 'agentcore-browser',
    label: 'Cloud browser (AWS)',
    entry: {
      slug: 'agentcore-browser',
      name: 'Cloud browser',
      description: 'A real Chrome in AWS — reads JavaScript-rendered pages and operates web apps that have no API. Billed per second of browser time.',
      category: 'data',
      transport: 'builtin' as const,
      provider: 'agentcore-browser',
      // No credential: it uses the platform AWS keys Bedrock already uses.
      authHint: 'No key needed — it authenticates with the platform AWS credentials.',
    },
  },
  {
    key: 'firecrawl',
    label: 'Firecrawl (web search + scrape)',
    entry: {
      slug: 'firecrawl',
      name: 'Firecrawl',
      description: 'Search the web and read any page as clean markdown — including JavaScript-rendered sites that fetch_url cannot see.',
      category: 'data',
      transport: 'http' as const,
      // The API key goes in the URL PATH, so this is a TEMPLATE: `{key}` is
      // replaced at call time with the vaulted secret (see applyUrlSecret).
      // The key is never written to the connections table in plaintext.
      url: 'https://mcp.firecrawl.dev/{key}/v2/mcp',
      authHeader: 'url', // reserved: substitute into the URL, don't send a header
      authHint: 'Your Firecrawl API key (fc-…) from firecrawl.dev. It is stored encrypted and injected into the request URL at call time.',
    },
  },
  {
    key: 'zernio',
    label: 'Zernio (social media)',
    entry: {
      slug: 'zernio',
      name: 'Zernio',
      description: 'Schedule and publish social posts across 14+ platforms, plus analytics, inbox and ads.',
      category: 'marketing',
      transport: 'http' as const,
      // Streamable HTTP endpoint. Zernio also offers OAuth via Claude's own
      // Connectors UI — irrelevant here; server-to-server uses the API key.
      url: 'https://mcp.zernio.com/mcp',
      authHeader: 'Authorization',
      // The `Bearer ` prefix is REQUIRED and is the usual cause of Zernio's
      // `401 invalid_token` — pasting the bare key silently fails.
      authHint: 'Bearer <your API key> from zernio.com/dashboard/api-keys. Keep the "Bearer " prefix — without it Zernio returns 401 invalid_token.',
    },
  },
  {
    key: 'duda',
    label: 'Duda (websites)',
    entry: {
      slug: 'duda',
      name: 'Duda',
      description: 'Build and manage Duda websites — pages, content, publishing.',
      category: 'dev',
      transport: 'http' as const,
      url: 'https://mcp.duda.co/mcp',
      authHeader: 'Authorization',
      authHint: 'Your Duda MCP Access Token (Duda dashboard → Account Settings → MCP).',
    },
  },
  {
    key: 'google-analytics',
    label: 'Google Analytics 4 + Search Console',
    entry: {
      slug: 'google-analytics',
      name: 'Google Analytics + Search Console',
      description: 'GA4 traffic, engagement and conversions, plus the Search Console queries a site ranks for. Read-only, and free — Google does not bill these APIs.',
      category: 'data',
      transport: 'builtin' as const,
      provider: 'google-analytics',
      // Per-connection: the workspace supplies its own GA4 property ID (in the
      // connection's site/URL field) and its own service account JSON.
      authHint: 'The WHOLE service account JSON key file. Cloud Console → IAM → Service Accounts → Keys → Add key (JSON). Then grant that service account email Viewer on the GA4 property, and add it as a user in Search Console → Settings → Users and permissions. Do NOT use an OAuth client ID: a consent screen in "Testing" issues refresh tokens that expire after 7 days, which would silently blind the agent every week.',
    },
  },
  {
    key: 'wordpress',
    label: 'WordPress (any site)',
    entry: {
      slug: 'wordpress',
      name: 'WordPress',
      description: 'Publish and edit posts and pages on a WordPress site.',
      category: 'dev',
      transport: 'builtin' as const,
      provider: 'wordpress',
      authHint: 'username:application password — create one in WP Admin → Users → Profile → Application Passwords.',
    },
  },
  {
    key: 'heygen',
    label: 'HeyGen (AI avatar video)',
    entry: {
      slug: 'heygen',
      name: 'HeyGen',
      description: 'Generate talking-avatar / spokesperson videos from a script. Async render; billed by HeyGen against the plan that owns the API key.',
      category: 'marketing',
      transport: 'builtin' as const,
      provider: 'heygen',
      // Built-in provider (REST API, X-Api-Key). HeyGen's hosted MCP is
      // OAuth-only and Artivio's MCP client sends static headers only, so the
      // remote MCP URL 401s — the REST adapter is the supported path.
      authHint: 'Your HeyGen API key from app.heygen.com → Settings → API. Paste the raw key (no "Bearer" prefix); it is sent as the X-Api-Key header.',
    },
  },
  {
    key: 'cloudflare-analytics',
    label: 'Cloudflare Web Analytics (site traffic)',
    entry: {
      slug: 'cloudflare-analytics',
      name: 'Cloudflare Analytics',
      description: 'Near-realtime site traffic — page views, visits, top pages, referrers, countries, devices — from Cloudflare Web Analytics.',
      category: 'data',
      transport: 'builtin' as const,
      provider: 'cloudflare-analytics',
      // Per-connection: the connection URL field holds "<accountTag>/<siteTag>",
      // the credential is a CF API token with Account Analytics : Read.
      authHint: 'Connection URL = "<accountTag>/<siteTag>" (Account ID + Web Analytics site tag). Credential = a Cloudflare API token with Account Analytics : Read.',
    },
  },
  {
    key: 'diviops',
    label: 'DiviOps (Divi 5 websites)',
    entry: {
      slug: 'diviops',
      name: 'DiviOps',
      description: 'Author and manage Divi 5 WordPress sites — pages, sections, modules, templates, presets, rendered previews. Draft-first, with dry-run on every write tool.',
      category: 'dev',
      // stdio: a bundled MCP server (@diviops/mcp-server) spawned as a child
      // process — see src/libs/mcp/stdioCatalog.ts (the allowlist) and
      // stdioClient.ts (the transport). Per-connection like WordPress.
      transport: 'stdio' as const,
      provider: 'diviops',
      authHeader: 'credential',
      authHint: 'username:application password for the client\'s WordPress site (WP Admin → Users → Profile → Application Passwords). The site must also have the diviops-agent WordPress plugin installed. You\'ll be asked for the site URL when enabling.',
    },
  },
  {
    key: 'github',
    label: 'GitHub (site repos)',
    entry: {
      slug: 'github',
      name: 'GitHub',
      description: 'Read and edit the code behind any site hosted from a Git repo. Pushing to the deploy branch publishes the site.',
      category: 'dev',
      transport: 'http' as const,
      url: 'https://api.githubcopilot.com/mcp/x/repos',
      authHeader: 'Authorization',
      authHint: 'Bearer <fine-grained PAT> with Contents read/write on the site repos.',
    },
  },
];
