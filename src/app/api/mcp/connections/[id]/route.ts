/**
 * PATCH  /api/mcp/connections/[id] — edit the connection: enable/disable,
 *        toolPolicy, and (added 2026-07-15) name / url / auth header + value.
 * DELETE /api/mcp/connections/[id] — remove connection (+ its credentials)
 * Owners/admins only.
 *
 * WHY EDITING EXISTS: a mis-typed URL or a key pasted without its `Bearer `
 * prefix used to be unfixable — the only options were Remove and start again,
 * which also silently dropped the tool policies. This is the SAME defect Ryan
 * hit on the Kie.ai catalog entry in Phase 11; it was fixed there and the
 * lesson wasn't carried across to workspace connections. If a form can create
 * a thing, it must be able to correct that thing.
 */

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { sealSecret } from '@/libs/vault';
import { auditLog, credentials, mcpConnections } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const MANAGER_ROLES = ['owner', 'admin'];

async function loadManaged(userId: string, isAdmin: boolean, connectionId: string) {
  const [conn] = await db
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.id, connectionId))
    .limit(1);
  if (!conn) {
    return null;
  }
  const tenant = (await getUserTenants(userId)).find(t => t.id === conn.tenantId);
  if (!tenant || (!isAdmin && !MANAGER_ROLES.includes(tenant.role))) {
    return null;
  }
  return { conn, tenant };
}

const PatchSchema = z.object({
  enabled: z.boolean().optional(),
  toolPolicy: z.record(z.string(), z.enum(['auto', 'approval', 'deny'])).optional(),
  name: z.string().min(1).max(60).optional(),
  url: z.string().url().max(500).optional(),
  authHeader: z.string().max(80).optional(),
  // Blank/omitted = keep the existing sealed value. The value is NEVER read
  // back to the client, so "leave it alone" has to be expressible.
  authValue: z.string().max(4000).optional(),
});

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;

  let body: z.infer<typeof PatchSchema>;
  try {
    body = PatchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const managed = await loadManaged(user.id, user.isAdmin, id);
  if (!managed) {
    return NextResponse.json({ error: 'Not found or no access.' }, { status: 404 });
  }

  // ── Auth header / credential rotation ────────────────────────────────────
  // headerCredentials maps headerName → credentialId. Renaming the header or
  // supplying a new value means re-sealing; either way the old credential row
  // is removed so a rotated key doesn't linger in the vault.
  const existing = (managed.conn.headerCredentials ?? {}) as Record<string, string>;
  const oldHeader = Object.keys(existing)[0] ?? null;
  const oldCredId = oldHeader ? existing[oldHeader] : undefined;
  let headerCredentials: Record<string, string> | undefined;

  const wantsHeaderChange = body.authHeader !== undefined || (body.authValue ?? '') !== '';
  if (wantsHeaderChange) {
    const header = (body.authHeader ?? oldHeader ?? '').trim();
    const value = (body.authValue ?? '').trim();

    if (!header) {
      // Clearing the header entirely — connection becomes unauthenticated.
      headerCredentials = {};
    } else if (value) {
      // New secret supplied → seal a fresh credential.
      const connName = body.name ?? managed.conn.name;
      const [cred] = await db
        .insert(credentials)
        .values({
          tenantId: managed.tenant.id,
          provider: connName,
          label: `${connName} · ${header}`.slice(0, 120), // column is varchar(120)
          cipher: sealSecret(value),
        })
        .returning({ id: credentials.id });
      if (!cred) {
        return NextResponse.json({ error: 'Could not store the credential.' }, { status: 500 });
      }
      headerCredentials = { [header]: cred.id };
    } else if (oldCredId) {
      // Header renamed but no new secret → keep the sealed value, re-key it.
      headerCredentials = { [header]: oldCredId };
    }
  }

  await db
    .update(mcpConnections)
    .set({
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.toolPolicy !== undefined ? { toolPolicy: body.toolPolicy } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.url !== undefined ? { url: body.url } : {}),
      ...(headerCredentials !== undefined ? { headerCredentials } : {}),
    })
    .where(eq(mcpConnections.id, id));

  // Drop the superseded credential only AFTER the connection stops pointing at
  // it — a crash between the two would otherwise leave a connection referencing
  // a deleted secret.
  const stillUsed = Object.values(headerCredentials ?? existing);
  if (oldCredId && !stillUsed.includes(oldCredId)) {
    await db
      .delete(credentials)
      .where(and(eq(credentials.id, oldCredId), eq(credentials.tenantId, managed.tenant.id)))
      .catch(() => {});
  }

  await db.insert(auditLog).values({
    tenantId: managed.tenant.id,
    actor: user.id,
    action: 'connection.update',
    target: managed.conn.name,
    // NEVER the secret. Record only which fields changed.
    detail: {
      changed: Object.keys(body).filter(k => k !== 'authValue'),
      secretRotated: (body.authValue ?? '') !== '',
    },
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;

  const managed = await loadManaged(user.id, user.isAdmin, id);
  if (!managed) {
    return NextResponse.json({ error: 'Not found or no access.' }, { status: 404 });
  }

  // Delete the credentials this connection references, then the connection.
  const credIds = Object.values((managed.conn.headerCredentials ?? {}) as Record<string, string>);
  for (const credId of credIds) {
    await db
      .delete(credentials)
      .where(and(eq(credentials.id, credId), eq(credentials.tenantId, managed.tenant.id)));
  }
  await db.delete(mcpConnections).where(eq(mcpConnections.id, id));

  await db.insert(auditLog).values({
    tenantId: managed.tenant.id,
    actor: user.id,
    action: 'connection.delete',
    target: managed.conn.name,
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
