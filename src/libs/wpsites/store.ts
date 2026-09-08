/**
 * WordPress Sites — persistence. The only module that touches `wp_sites` and
 * `workspace_ssh_keys`, and the only one that opens their secrets.
 *
 * Every query is tenant-scoped at the WHERE clause; a site id from another
 * workspace is simply "not found".
 */

import type { AuthScheme, Builder, PublicSite, ResolvedSite, SiteCapabilities, SitePolicy, SitePolicyValue, SiteStatus, TestReport } from '@/libs/wpsites/types';
import { createHash } from 'node:crypto';
import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { generateSshKeyPair } from '@/libs/plugins/sshKey';
import { openSecret, sealSecret, vaultConfigured } from '@/libs/vault';
import { LABEL_RE, maskSecret, normaliseLabel, normaliseSecret, normaliseSiteUrl } from '@/libs/wpsites/auth';
import { DEFAULT_SITE_POLICY, EMPTY_CAPABILITIES } from '@/libs/wpsites/types';
import { workspaceSshKeys, wpSites } from '@/models/Schema';

type Row = typeof wpSites.$inferSelect;

const POLICY_VALUES = new Set<SitePolicyValue>(['auto', 'ask', 'blocked']);

export function coercePolicy(raw: unknown): SitePolicy {
  const p = (raw ?? {}) as Partial<Record<string, unknown>>;
  const pick = (k: 'rest' | 'mcp' | 'cli'): SitePolicyValue =>
    POLICY_VALUES.has(p[k] as SitePolicyValue) ? (p[k] as SitePolicyValue) : DEFAULT_SITE_POLICY[k];
  return { rest: pick('rest'), mcp: pick('mcp'), cli: pick('cli') };
}

function coerceCapabilities(raw: unknown): SiteCapabilities {
  const c = (raw ?? {}) as Partial<SiteCapabilities>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    rest: Boolean(c.rest),
    mcp: Boolean(c.mcp),
    cli: Boolean(c.cli),
    builder_abilities: arr(c.builder_abilities),
    plugins: arr(c.plugins),
    mcp_tools: arr(c.mcp_tools),
    namespaces: arr(c.namespaces),
    base_plugin: Boolean(c.base_plugin),
    roles: arr(c.roles),
  };
}

function toPublic(row: Row): PublicSite {
  let secretMask = '••••••••';
  try {
    secretMask = maskSecret(openSecret(row.authSecretEnc));
  } catch { /* vault not configured or key rotated — mask stays generic */ }
  return {
    id: row.id,
    label: row.label,
    isDefault: row.isDefault,
    siteUrl: row.siteUrl,
    authScheme: (row.authScheme === 'bearer' ? 'bearer' : 'basic'),
    authUser: row.authUser,
    secretMask,
    ssh: row.sshHost && row.sshUser && row.wpPath
      ? { host: row.sshHost, port: row.sshPort ?? 22, user: row.sshUser, path: row.wpPath, keyId: row.sshKeyId }
      : null,
    mcpEndpointUrl: row.mcpEndpointUrl,
    wpVersion: row.wpVersion,
    phpVersion: row.phpVersion,
    builder: (row.builder as Builder | null) ?? null,
    builderVersion: row.builderVersion,
    agentConnectorVersion: row.agentConnectorVersion,
    capabilities: coerceCapabilities(row.capabilities),
    policy: coercePolicy(row.policy),
    status: row.status as SiteStatus,
    lastTestAt: row.lastTestAt ? row.lastTestAt.toISOString() : null,
    lastTestReport: (row.lastTestReport as TestReport | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function toResolved(row: Row): Promise<ResolvedSite> {
  let privateKey: string | null = null;
  if (row.sshKeyId) {
    const [key] = await db
      .select()
      .from(workspaceSshKeys)
      .where(and(eq(workspaceSshKeys.id, row.sshKeyId), eq(workspaceSshKeys.tenantId, row.tenantId)))
      .limit(1);
    if (key) {
      privateKey = openSecret(key.privateKeyEnc);
    }
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    label: row.label,
    isDefault: row.isDefault,
    siteUrl: row.siteUrl,
    authScheme: row.authScheme === 'bearer' ? 'bearer' : 'basic',
    authUser: row.authUser,
    authSecret: openSecret(row.authSecretEnc),
    appPasswordUuid: row.appPasswordUuid,
    ssh: row.sshHost && row.sshUser && row.wpPath && privateKey
      ? { host: row.sshHost, port: row.sshPort ?? 22, user: row.sshUser, path: row.wpPath.replace(/\/+$/, '') || '/', privateKey }
      : null,
    mcpEndpointUrl: row.mcpEndpointUrl,
    builder: (row.builder as Builder | null) ?? null,
    capabilities: coerceCapabilities(row.capabilities),
    policy: coercePolicy(row.policy),
    status: row.status as SiteStatus,
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listSites(tenantId: string): Promise<PublicSite[]> {
  const rows = await db.select().from(wpSites).where(eq(wpSites.tenantId, tenantId)).orderBy(asc(wpSites.label));
  return rows.map(toPublic);
}

export async function getSiteRow(tenantId: string, id: string): Promise<Row | null> {
  const [row] = await db.select().from(wpSites).where(and(eq(wpSites.tenantId, tenantId), eq(wpSites.id, id))).limit(1);
  return row ?? null;
}

export async function getPublicSite(tenantId: string, id: string): Promise<PublicSite | null> {
  const row = await getSiteRow(tenantId, id);
  return row ? toPublic(row) : null;
}

export async function getResolvedSite(tenantId: string, id: string): Promise<ResolvedSite | null> {
  const row = await getSiteRow(tenantId, id);
  return row ? toResolved(row) : null;
}

/**
 * The site a tool call means. No label → the default site, or the only site;
 * with several sites and no default the agent must ask, and the error names
 * the labels so it can.
 */
export async function resolveSiteByLabel(tenantId: string, label: string | undefined): Promise<ResolvedSite> {
  const rows = await db.select().from(wpSites).where(eq(wpSites.tenantId, tenantId)).orderBy(asc(wpSites.label));
  if (rows.length === 0) {
    throw new Error('WordPress Sites: no sites are configured in this workspace yet. The owner adds them in Tools → WordPress Sites.');
  }
  const wanted = normaliseLabel(label ?? '');
  if (wanted) {
    const hit = rows.find(r => r.label === wanted);
    if (!hit) {
      throw new Error(`WordPress Sites: no site labelled "${wanted}". Available: ${rows.map(r => r.label).join(', ')}. This is a WRONG ARGUMENT — call wp_sites to see the labels.`);
    }
    return toResolved(hit);
  }
  if (rows.length === 1) {
    return toResolved(rows[0]!);
  }
  const def = rows.find(r => r.isDefault);
  if (def) {
    return toResolved(def);
  }
  throw new Error(`WordPress Sites: this workspace has ${rows.length} sites and no default — pass site="<label>". Available: ${rows.map(r => r.label).join(', ')}. If the task did not say which site, ask the human.`);
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export type SiteInput = {
  label: string;
  siteUrl: string;
  authScheme?: AuthScheme;
  authUser?: string | null;
  /** Plaintext; sealed here. Omit on update to keep the stored one. */
  authSecret?: string;
  isDefault?: boolean;
  ssh?: { host: string; port?: number; user: string; path: string; keyId: string | null } | null;
  policy?: Partial<SitePolicy>;
};

function validateInput(input: SiteInput, forCreate: boolean) {
  const label = normaliseLabel(input.label);
  if (!LABEL_RE.test(label)) {
    throw new Error('Label must be 2–60 characters: letters, numbers and dashes (e.g. "noah-build").');
  }
  const siteUrl = normaliseSiteUrl(input.siteUrl);
  const authScheme: AuthScheme = input.authScheme === 'bearer' ? 'bearer' : 'basic';
  const authUser = authScheme === 'basic' ? (input.authUser ?? '').trim() : null;
  if (authScheme === 'basic' && !authUser) {
    throw new Error('Username is required with an application password.');
  }
  if (forCreate && !input.authSecret?.trim()) {
    throw new Error(authScheme === 'basic' ? 'Application password is required.' : 'Token is required.');
  }
  let ssh: { host: string; port: number; user: string; path: string; keyId: string | null } | null = null;
  if (input.ssh) {
    const host = input.ssh.host.trim();
    const user = input.ssh.user.trim();
    const path = input.ssh.path.trim().replace(/\/+$/, '');
    const port = Number(input.ssh.port ?? 22);
    if (!/^[\w.-]+$/.test(host)) {
      throw new Error('SSH host must be a hostname or IP.');
    }
    if (!/^[\w.+-]+$/.test(user)) {
      throw new Error('SSH user contains characters that are not allowed.');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SSH port must be 1–65535.');
    }
    if (!/^\/[^\s'"`$;&|<>]*$/.test(path)) {
      throw new Error('WP path must be an absolute path (the folder containing wp-config.php).');
    }
    if (!input.ssh.keyId) {
      throw new Error('Pick a workspace SSH key for the WP-CLI channel (or disable it).');
    }
    ssh = { host, user, path: path || '/', port, keyId: input.ssh.keyId };
  }
  return { label, siteUrl, authScheme, authUser, ssh };
}

async function assertKeyBelongs(tenantId: string, keyId: string) {
  const [k] = await db.select({ id: workspaceSshKeys.id }).from(workspaceSshKeys).where(and(eq(workspaceSshKeys.id, keyId), eq(workspaceSshKeys.tenantId, tenantId))).limit(1);
  if (!k) {
    throw new Error('That SSH key does not belong to this workspace.');
  }
}

async function clearOtherDefaults(tenantId: string, keepId: string) {
  await db.update(wpSites).set({ isDefault: false }).where(and(eq(wpSites.tenantId, tenantId), ne(wpSites.id, keepId)));
}

export async function createSite(tenantId: string, input: SiteInput): Promise<PublicSite> {
  if (!vaultConfigured()) {
    throw new Error('Credential vault is not configured (VAULT_MASTER_KEY).');
  }
  const v = validateInput(input, true);
  if (v.ssh) {
    await assertKeyBelongs(tenantId, v.ssh.keyId!);
  }
  const existing = await db.select({ id: wpSites.id }).from(wpSites).where(eq(wpSites.tenantId, tenantId));
  const [row] = await db.insert(wpSites).values({
    tenantId,
    label: v.label,
    // The first site in a workspace is the default — the common case is one site.
    isDefault: input.isDefault ?? existing.length === 0,
    siteUrl: v.siteUrl,
    authScheme: v.authScheme,
    authUser: v.authUser,
    authSecretEnc: sealSecret(normaliseSecret(v.authScheme, input.authSecret!)),
    sshHost: v.ssh?.host ?? null,
    sshPort: v.ssh?.port ?? null,
    sshUser: v.ssh?.user ?? null,
    wpPath: v.ssh?.path ?? null,
    sshKeyId: v.ssh?.keyId ?? null,
    capabilities: EMPTY_CAPABILITIES,
    policy: coercePolicy({ ...DEFAULT_SITE_POLICY, ...(input.policy ?? {}) }),
    status: 'untested',
  }).returning();
  if (!row) {
    throw new Error('Could not save the site.');
  }
  if (row.isDefault) {
    await clearOtherDefaults(tenantId, row.id);
  }
  return toPublic(row);
}

export async function updateSite(tenantId: string, id: string, input: SiteInput): Promise<PublicSite> {
  const current = await getSiteRow(tenantId, id);
  if (!current) {
    throw new Error('Site not found.');
  }
  const v = validateInput(input, false);
  if (v.ssh) {
    await assertKeyBelongs(tenantId, v.ssh.keyId!);
  }
  const secret = input.authSecret?.trim();
  const [row] = await db.update(wpSites).set({
    label: v.label,
    isDefault: input.isDefault ?? current.isDefault,
    siteUrl: v.siteUrl,
    authScheme: v.authScheme,
    authUser: v.authUser,
    ...(secret ? { authSecretEnc: sealSecret(normaliseSecret(v.authScheme, secret)), appPasswordUuid: null } : {}),
    sshHost: v.ssh?.host ?? null,
    sshPort: v.ssh?.port ?? null,
    sshUser: v.ssh?.user ?? null,
    wpPath: v.ssh?.path ?? null,
    sshKeyId: v.ssh?.keyId ?? null,
    policy: coercePolicy({ ...coercePolicy(current.policy), ...(input.policy ?? {}) }),
    // Anything that changes what we talk to invalidates what we learned.
    ...(v.siteUrl !== current.siteUrl ? { status: 'untested', mcpEndpointUrl: null } : {}),
    updatedAt: new Date(),
  }).where(and(eq(wpSites.tenantId, tenantId), eq(wpSites.id, id))).returning();
  if (!row) {
    throw new Error('Site not found.');
  }
  if (row.isDefault) {
    await clearOtherDefaults(tenantId, row.id);
  }
  return toPublic(row);
}

export async function setSitePolicy(tenantId: string, id: string, policy: Partial<SitePolicy>): Promise<PublicSite> {
  const current = await getSiteRow(tenantId, id);
  if (!current) {
    throw new Error('Site not found.');
  }
  const [row] = await db.update(wpSites)
    .set({ policy: coercePolicy({ ...coercePolicy(current.policy), ...policy }), updatedAt: new Date() })
    .where(and(eq(wpSites.tenantId, tenantId), eq(wpSites.id, id)))
    .returning();
  return toPublic(row!);
}

export async function setDefaultSite(tenantId: string, id: string): Promise<void> {
  const current = await getSiteRow(tenantId, id);
  if (!current) {
    throw new Error('Site not found.');
  }
  await db.update(wpSites).set({ isDefault: true, updatedAt: new Date() }).where(eq(wpSites.id, id));
  await clearOtherDefaults(tenantId, id);
}

export async function deleteSite(tenantId: string, id: string): Promise<boolean> {
  const deleted = await db.delete(wpSites).where(and(eq(wpSites.tenantId, tenantId), eq(wpSites.id, id))).returning({ id: wpSites.id });
  return deleted.length > 0;
}

/** Rotation stores the NEW secret (and its uuid) — the old one is gone on the site already. */
export async function replaceSiteSecret(tenantId: string, id: string, secret: string, appPasswordUuid: string | null): Promise<void> {
  await db.update(wpSites)
    .set({ authSecretEnc: sealSecret(normaliseSecret('basic', secret)), appPasswordUuid, updatedAt: new Date() })
    .where(and(eq(wpSites.tenantId, tenantId), eq(wpSites.id, id)));
}

export type Discovered = {
  /** Set when the test found the site redirects http→https on the same host: the URL to store from now on. */
  siteUrl?: string;
  mcpEndpointUrl?: string | null;
  wpVersion?: string | null;
  phpVersion?: string | null;
  builder?: Builder | null;
  builderVersion?: string | null;
  agentConnectorVersion?: string | null;
  appPasswordUuid?: string | null;
  capabilities: SiteCapabilities;
};

export async function storeTestResult(tenantId: string, id: string, discovered: Discovered, report: TestReport): Promise<void> {
  await db.update(wpSites).set({
    ...(discovered.siteUrl !== undefined ? { siteUrl: discovered.siteUrl } : {}),
    ...(discovered.mcpEndpointUrl !== undefined ? { mcpEndpointUrl: discovered.mcpEndpointUrl } : {}),
    ...(discovered.wpVersion !== undefined ? { wpVersion: discovered.wpVersion } : {}),
    ...(discovered.phpVersion !== undefined ? { phpVersion: discovered.phpVersion } : {}),
    ...(discovered.builder !== undefined ? { builder: discovered.builder } : {}),
    ...(discovered.builderVersion !== undefined ? { builderVersion: discovered.builderVersion } : {}),
    ...(discovered.agentConnectorVersion !== undefined ? { agentConnectorVersion: discovered.agentConnectorVersion } : {}),
    ...(discovered.appPasswordUuid !== undefined ? { appPasswordUuid: discovered.appPasswordUuid } : {}),
    capabilities: discovered.capabilities,
    status: report.status,
    lastTestAt: new Date(),
    lastTestReport: report,
    updatedAt: new Date(),
  }).where(and(eq(wpSites.tenantId, tenantId), eq(wpSites.id, id)));
}

// ─── Workspace SSH keys ──────────────────────────────────────────────────────

export type PublicSshKey = { id: string; label: string; publicKey: string; fingerprint: string; createdAt: string };

export async function listSshKeys(tenantId: string): Promise<PublicSshKey[]> {
  const rows = await db.select().from(workspaceSshKeys).where(eq(workspaceSshKeys.tenantId, tenantId)).orderBy(asc(workspaceSshKeys.createdAt));
  return rows.map(r => ({ id: r.id, label: r.label, publicKey: r.publicKey, fingerprint: r.fingerprint, createdAt: r.createdAt.toISOString() }));
}

/** SHA256 fingerprint of the public key blob, as `ssh-keygen -l` prints it. */
export function fingerprintPublicKey(publicKeyOpenSsh: string): string {
  const blob = publicKeyOpenSsh.split(/\s+/)[1] ?? '';
  const digest = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/**
 * Mint a key pair on the platform and seal the private half. One key per
 * workspace by default ("workspace-default"), reusable across all its sites so
 * the public key is pasted into the host's panel once.
 */
export async function createSshKey(tenantId: string, tenantSlug: string, label = 'workspace-default'): Promise<PublicSshKey> {
  if (!vaultConfigured()) {
    throw new Error('Credential vault is not configured (VAULT_MASTER_KEY).');
  }
  const safeLabel = normaliseLabel(label) || 'workspace-default';
  const pair = generateSshKeyPair(`artivio-${tenantSlug}-${safeLabel}`);
  const [row] = await db.insert(workspaceSshKeys).values({
    tenantId,
    label: safeLabel,
    publicKey: pair.publicKeyOpenSsh,
    privateKeyEnc: sealSecret(pair.privateKeyPem),
    fingerprint: fingerprintPublicKey(pair.publicKeyOpenSsh),
  }).returning();
  if (!row) {
    throw new Error('Could not store the key.');
  }
  return { id: row.id, label: row.label, publicKey: row.publicKey, fingerprint: row.fingerprint, createdAt: row.createdAt.toISOString() };
}

/** Import an existing PEM (legacy wpcli connections carry one). */
export async function importSshKey(tenantId: string, tenantSlug: string, label: string, privateKeyPem: string, publicKeyOpenSsh: string): Promise<PublicSshKey> {
  const safeLabel = normaliseLabel(label) || `imported-${Date.now()}`;
  const [row] = await db.insert(workspaceSshKeys).values({
    tenantId,
    label: safeLabel,
    publicKey: publicKeyOpenSsh,
    privateKeyEnc: sealSecret(privateKeyPem),
    fingerprint: fingerprintPublicKey(publicKeyOpenSsh),
  }).returning();
  void tenantSlug;
  return { id: row!.id, label: row!.label, publicKey: row!.publicKey, fingerprint: row!.fingerprint, createdAt: row!.createdAt.toISOString() };
}

export async function deleteSshKey(tenantId: string, id: string): Promise<boolean> {
  const inUse = await db.select({ id: wpSites.id }).from(wpSites).where(and(eq(wpSites.tenantId, tenantId), eq(wpSites.sshKeyId, id))).limit(1);
  if (inUse.length > 0) {
    throw new Error('This key is used by a site — switch the site to another key first.');
  }
  const deleted = await db.delete(workspaceSshKeys).where(and(eq(workspaceSshKeys.tenantId, tenantId), eq(workspaceSshKeys.id, id))).returning({ id: workspaceSshKeys.id });
  return deleted.length > 0;
}
