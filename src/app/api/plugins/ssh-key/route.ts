/**
 * SSH keys for SSH-backed per-connection plugins (WP-CLI).
 *
 * POST /api/plugins/ssh-key  {tenantSlug, pluginId}
 *   Generates a key pair ON THE PLATFORM, seals the private key into this
 *   workspace's vault as a credential row, and returns { credentialId,
 *   publicKey }. The client pastes the public key into their host's SSH keys
 *   page and then enables the plugin with `credentialId` (see /api/plugins).
 *   The private key is never returned, logged, or shown.
 *
 * GET  /api/plugins/ssh-key?tenant=<slug>&connection=<id>
 *   Re-derives the PUBLIC key for an already-connected SSH-backed plugin, so
 *   the client can add it to a second host or re-add it after a panel reset.
 *
 * Owners/admins only, same as enabling a plugin.
 */

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getBuiltinProvider } from '@/libs/plugins';
import { derivePublicKey, generateSshKeyPair } from '@/libs/plugins/sshKey';
import { getUserTenants } from '@/libs/tenants';
import { openSecret, sealSecret, vaultConfigured } from '@/libs/vault';
import { auditLog, credentials, mcpConnections, pluginCatalog } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const MANAGER_ROLES = ['owner', 'admin'];

async function requireManaged(userId: string, isAdmin: boolean, slug: string) {
  const tenant = (await getUserTenants(userId)).find(t => t.slug === slug);
  if (!tenant || (!isAdmin && !MANAGER_ROLES.includes(tenant.role))) {
    return null;
  }
  return tenant;
}

const GenerateSchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  pluginId: z.string().uuid(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: z.infer<typeof GenerateSchema>;
  try {
    body = GenerateSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const tenant = await requireManaged(user.id, user.isAdmin, body.tenantSlug);
  if (!tenant) {
    return NextResponse.json({ error: 'You need owner/admin access to add tools.' }, { status: 403 });
  }
  if (!vaultConfigured()) {
    return NextResponse.json({ error: 'Credential vault is not configured.' }, { status: 500 });
  }

  const [plugin] = await db.select().from(pluginCatalog).where(eq(pluginCatalog.id, body.pluginId)).limit(1);
  const provider = plugin?.transport === 'builtin' && plugin.provider ? getBuiltinProvider(plugin.provider) : undefined;
  if (!plugin || !plugin.enabled || provider?.credentialKind !== 'ssh-key') {
    return NextResponse.json({ error: 'This plugin does not use a generated SSH key.' }, { status: 400 });
  }

  const pair = generateSshKeyPair(`artivio-${tenant.slug}-${plugin.slug}`);
  const [cred] = await db
    .insert(credentials)
    .values({
      tenantId: tenant.id,
      provider: plugin.slug,
      label: `${plugin.slug} · ssh private key`.slice(0, 120),
      cipher: sealSecret(pair.privateKeyPem),
    })
    .returning({ id: credentials.id });
  if (!cred) {
    return NextResponse.json({ error: 'Could not store the key.' }, { status: 500 });
  }

  await db.insert(auditLog).values({
    tenantId: tenant.id,
    actor: user.id,
    action: 'plugin.ssh_key.generate',
    target: plugin.slug,
    detail: { credentialId: cred.id }, // the id only — never key material
  }).catch(() => {});

  return NextResponse.json({ credentialId: cred.id, publicKey: pair.publicKeyOpenSsh });
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = new URL(request.url);
  const slug = url.searchParams.get('tenant') ?? '';
  const connectionId = url.searchParams.get('connection') ?? '';
  const tenant = await requireManaged(user.id, user.isAdmin, slug);
  if (!tenant) {
    return NextResponse.json({ error: 'You need owner/admin access.' }, { status: 403 });
  }
  if (!z.string().uuid().safeParse(connectionId).success) {
    return NextResponse.json({ error: 'connection is required.' }, { status: 400 });
  }

  // Re-scoped by tenant: a connection id from another workspace is a 404 here.
  const [conn] = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.id, connectionId), eq(mcpConnections.tenantId, tenant.id)))
    .limit(1);
  const [entry] = conn?.catalogId
    ? await db.select().from(pluginCatalog).where(eq(pluginCatalog.id, conn.catalogId)).limit(1)
    : [undefined];
  const provider = entry?.transport === 'builtin' && entry.provider ? getBuiltinProvider(entry.provider) : undefined;
  if (!conn || provider?.credentialKind !== 'ssh-key') {
    return NextResponse.json({ error: 'Not an SSH-backed connection.' }, { status: 404 });
  }
  const credentialId = Object.values((conn.headerCredentials ?? {}) as Record<string, string>)[0];
  const [cred] = credentialId
    ? await db.select().from(credentials).where(and(eq(credentials.id, credentialId), eq(credentials.tenantId, tenant.id))).limit(1)
    : [undefined];
  if (!cred) {
    return NextResponse.json({ error: 'This connection has no stored key.' }, { status: 404 });
  }
  try {
    const publicKey = derivePublicKey(openSecret(cred.cipher), `artivio-${tenant.slug}-${entry?.slug ?? 'ssh'}`);
    return NextResponse.json({ publicKey });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not derive the public key.' }, { status: 500 });
  }
}
