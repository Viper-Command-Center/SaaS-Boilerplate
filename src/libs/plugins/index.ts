/**
 * Registry of built-in providers (services with no hosted MCP server).
 * Adding one = write an adapter here; it appears in the admin catalog's
 * provider dropdown immediately.
 */

import type { BuiltinProvider } from '@/libs/plugins/types';
import { kieProvider } from '@/libs/plugins/kie';
import { wordpressProvider } from '@/libs/plugins/wordpress';

export const BUILTIN_PROVIDERS: Record<string, BuiltinProvider> = {
  [kieProvider.slug]: kieProvider,
  [wordpressProvider.slug]: wordpressProvider,
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
