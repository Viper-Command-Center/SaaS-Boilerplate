/**
 * Registry of built-in providers (services with no hosted MCP server).
 * Adding one = write an adapter here; it appears in the admin catalog's
 * provider dropdown immediately.
 */

import type { BuiltinProvider } from '@/libs/plugins/types';
import { agentcoreBrowserProvider } from '@/libs/plugins/agentcoreBrowser';
import { kieProvider } from '@/libs/plugins/kie';
import { wordpressProvider } from '@/libs/plugins/wordpress';

export const BUILTIN_PROVIDERS: Record<string, BuiltinProvider> = {
  [kieProvider.slug]: kieProvider,
  [wordpressProvider.slug]: wordpressProvider,
  [agentcoreBrowserProvider.slug]: agentcoreBrowserProvider,
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
