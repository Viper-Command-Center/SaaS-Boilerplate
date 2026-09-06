/**
 * Migration from the separate `wordpress` + `wpcli` connectors (§2) and the
 * "Add site from provisioning token" flow (§8).
 *
 * Legacy import is a one-click action in the Sites panel rather than a SQL
 * migration: the old rows hold sealed credentials that only the running app
 * can open, and matching a wpcli target (an IP + a path) to a wordpress site
 * (a hostname) is a heuristic worth showing the owner before it is committed.
 * Old connections are DISABLED, not deleted — one release of safety net.
 */

import type { PublicSite } from '@/libs/wpsites/types';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { derivePublicKey } from '@/libs/plugins/sshKey';
import { parseTarget } from '@/libs/plugins/wpcli';
import { openSecret } from '@/libs/vault';
import { normaliseLabel, normaliseSiteUrl } from '@/libs/wpsites/auth';
import { createSite, importSshKey, listSites, listSshKeys, updateSite } from '@/libs/wpsites/store';
import { credentials, mcpConnections, pluginCatalog } from '@/models/Schema';

const LEGACY_PROVIDERS = ['wordpress', 'wpcli'] as const;

type LegacyConn = {
  id: string;
  name: string;
  provider: 'wordpress' | 'wpcli';
  target: string;
  secret: string;
  enabled: boolean;
};

export async function findLegacyConnections(tenantId: string): Promise<Array<Omit<LegacyConn, 'secret'>>> {
  return (await loadLegacy(tenantId)).map(({ secret: _s, ...rest }) => rest);
}

async function loadLegacy(tenantId: string): Promise<LegacyConn[]> {
  const entries = await db.select({ id: pluginCatalog.id, provider: pluginCatalog.provider })
    .from(pluginCatalog)
    .where(and(eq(pluginCatalog.transport, 'builtin'), inArray(pluginCatalog.provider, [...LEGACY_PROVIDERS])));
  if (entries.length === 0) {
    return [];
  }
  const byCatalog = new Map(entries.map(e => [e.id, e.provider as 'wordpress' | 'wpcli']));
  const conns = await db.select().from(mcpConnections).where(and(eq(mcpConnections.tenantId, tenantId), inArray(mcpConnections.catalogId, entries.map(e => e.id))));
  const out: LegacyConn[] = [];
  for (const c of conns) {
    const provider = c.catalogId ? byCatalog.get(c.catalogId) : undefined;
    if (!provider || !c.url) {
      continue;
    }
    const credId = Object.values((c.headerCredentials ?? {}) as Record<string, string>)[0];
    const [cred] = credId ? await db.select().from(credentials).where(and(eq(credentials.id, credId), eq(credentials.tenantId, tenantId))).limit(1) : [undefined];
    if (!cred) {
      continue;
    }
    let secret = '';
    try {
      secret = openSecret(cred.cipher);
    } catch {
      continue;
    }
    out.push({ id: c.id, name: c.name, provider, target: c.url, secret, enabled: c.enabled });
  }
  return out;
}

function labelFromHost(url: string): string {
  const host = new URL(url).host.replace(/^www\./, '');
  // "build.churchwebglobal.com" → "build-churchwebglobal"; "example.com" → "example".
  const parts = host.split('.');
  const base = parts.length > 2 ? parts.slice(0, -1).join('-') : parts[0] ?? host;
  return normaliseLabel(base) || normaliseLabel(host) || 'site';
}

export type ImportSummary = { created: PublicSite[]; attachedCli: string[]; skipped: string[]; disabled: number };

/**
 * wordpress connection → a site (label from host). wpcli connection → the SSH
 * channel of the site whose hostname appears in its WP path, or of the only
 * site when there is exactly one; otherwise reported as skipped.
 */
export async function importLegacyConnections(tenantId: string, tenantSlug: string): Promise<ImportSummary> {
  const legacy = await loadLegacy(tenantId);
  const summary: ImportSummary = { created: [], attachedCli: [], skipped: [], disabled: 0 };
  if (legacy.length === 0) {
    return summary;
  }
  const existing = await listSites(tenantId);
  const taken = new Set(existing.map(s => s.label));
  const sites: PublicSite[] = [...existing];

  for (const c of legacy.filter(l => l.provider === 'wordpress')) {
    let siteUrl: string;
    try {
      siteUrl = normaliseSiteUrl(c.target);
    } catch {
      summary.skipped.push(`${c.name}: target "${c.target}" is not a URL`);
      continue;
    }
    if (sites.some(s => s.siteUrl === siteUrl)) {
      summary.skipped.push(`${c.name}: ${siteUrl} already registered`);
      continue;
    }
    const idx = c.secret.indexOf(':');
    if (idx < 1) {
      summary.skipped.push(`${c.name}: credential is not "username:application password"`);
      continue;
    }
    let label = labelFromHost(siteUrl);
    for (let n = 2; taken.has(label); n++) {
      label = `${labelFromHost(siteUrl)}-${n}`;
    }
    taken.add(label);
    try {
      const site = await createSite(tenantId, {
        label,
        siteUrl,
        authScheme: 'basic',
        authUser: c.secret.slice(0, idx),
        authSecret: c.secret.slice(idx + 1),
      });
      sites.push(site);
      summary.created.push(site);
    } catch (err) {
      summary.skipped.push(`${c.name}: ${err instanceof Error ? err.message : 'could not create'}`);
    }
  }

  for (const c of legacy.filter(l => l.provider === 'wpcli')) {
    let target: ReturnType<typeof parseTarget>;
    try {
      target = parseTarget(c.target);
    } catch (err) {
      summary.skipped.push(`${c.name}: ${err instanceof Error ? err.message : 'bad target'}`);
      continue;
    }
    const match = sites.find(s => target.path.toLowerCase().includes(new URL(s.siteUrl).host.toLowerCase().replace(/^www\./, '')))
      ?? (sites.length === 1 ? sites[0] : undefined);
    if (!match) {
      summary.skipped.push(`${c.name}: could not tell which site ${target.path} belongs to — add the SSH details on the right site by hand`);
      continue;
    }
    if (!c.secret.includes('PRIVATE KEY')) {
      summary.skipped.push(`${c.name}: stored credential is not a private key`);
      continue;
    }
    let publicKey: string;
    try {
      publicKey = derivePublicKey(c.secret, `artivio-${tenantSlug}-imported`);
    } catch (err) {
      summary.skipped.push(`${c.name}: ${err instanceof Error ? err.message : 'unusable key'}`);
      continue;
    }
    // Reuse an already-imported identical key rather than minting duplicates.
    const keys = await listSshKeys(tenantId);
    const blob = publicKey.split(/\s+/)[1];
    const same = keys.find(k => k.publicKey.split(/\s+/)[1] === blob);
    const key = same ?? await importSshKey(tenantId, tenantSlug, keys.length === 0 ? 'workspace-default' : `imported-${c.name}`, c.secret, publicKey);
    try {
      const updated = await updateSite(tenantId, match.id, {
        label: match.label,
        siteUrl: match.siteUrl,
        authScheme: match.authScheme,
        authUser: match.authUser,
        isDefault: match.isDefault,
        ssh: { host: target.host, port: target.port, user: target.user, path: target.path, keyId: key.id },
        policy: { cli: 'ask' },
      });
      sites[sites.indexOf(match)] = updated;
      summary.attachedCli.push(`${c.name} → ${match.label}`);
    } catch (err) {
      summary.skipped.push(`${c.name}: ${err instanceof Error ? err.message : 'could not attach'}`);
    }
  }

  // Disable what was imported (created or attached) — the old rows stay for one release.
  const handledNames = new Set([
    ...summary.created.map(s => s.siteUrl),
    ...summary.attachedCli.map(a => a.split(' → ')[0]!),
  ]);
  const toDisable = legacy.filter(l => l.enabled && (
    (l.provider === 'wordpress' && (() => {
      try {
        return handledNames.has(normaliseSiteUrl(l.target));
      } catch {
        return false;
      }
    })())
    || (l.provider === 'wpcli' && handledNames.has(l.name))
  ));
  if (toDisable.length > 0) {
    await db.update(mcpConnections).set({ enabled: false }).where(inArray(mcpConnections.id, toDisable.map(l => l.id)));
    summary.disabled = toDisable.length;
  }
  return summary;
}

// ─── Provisioning token (§8) ────────────────────────────────────────────────

export type ProvisioningPayload = { site_url: string; username: string; app_password: string; label?: string };

export function parseProvisioningPayload(raw: string): ProvisioningPayload {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error('Paste the JSON returned by the provisioning hook: {"site_url": …, "username": …, "app_password": …}.');
  }
  const o = (j ?? {}) as Record<string, unknown>;
  const site_url = String(o.site_url ?? o.siteUrl ?? '').trim();
  const username = String(o.username ?? o.user ?? '').trim();
  const app_password = String(o.app_password ?? o.appPassword ?? o.password ?? '').trim();
  if (!site_url || !username || !app_password) {
    throw new Error('The provisioning JSON needs site_url, username and app_password.');
  }
  return { site_url, username, app_password, label: typeof o.label === 'string' ? o.label : undefined };
}

export async function addSiteFromProvisioning(tenantId: string, payload: ProvisioningPayload): Promise<PublicSite> {
  const siteUrl = normaliseSiteUrl(payload.site_url);
  const existing = await listSites(tenantId);
  const taken = new Set(existing.map(s => s.label));
  let label = normaliseLabel(payload.label ?? '') || labelFromHost(siteUrl);
  const base = label;
  for (let n = 2; taken.has(label); n++) {
    label = `${base}-${n}`;
  }
  return createSite(tenantId, {
    label,
    siteUrl,
    authScheme: 'basic',
    authUser: payload.username,
    authSecret: payload.app_password,
  });
}
