/**
 * Registry of built-in (tier-1) providers. Adding a resold service = add an
 * adapter here; it then appears in the admin catalog's provider dropdown.
 */

import type { BuiltinProvider } from '@/libs/plugins/types';
import { kieProvider } from '@/libs/plugins/kie';

export const BUILTIN_PROVIDERS: Record<string, BuiltinProvider> = {
  [kieProvider.slug]: kieProvider,
};

export function getBuiltinProvider(slug: string): BuiltinProvider | undefined {
  return BUILTIN_PROVIDERS[slug];
}

/** For the admin UI: what can be added as a built-in tier-1 plugin. */
export function listBuiltinProviders() {
  return Object.values(BUILTIN_PROVIDERS).map(p => ({
    slug: p.slug,
    name: p.name,
    description: p.description,
    credentialLabel: p.credentialLabel,
    tools: p.tools.map(t => ({
      name: t.name,
      description: t.description,
      meteredArg: t.meteredArg,
    })),
  }));
}
