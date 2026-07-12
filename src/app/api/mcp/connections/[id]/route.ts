/**
 * PATCH  /api/mcp/connections/[id] — enable/disable or set toolPolicy
 * DELETE /api/mcp/connections/[id] — remove connection (+ its credentials)
 * Owners/admins only.
 */

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
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

  await db
    .update(mcpConnections)
    .set({
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.toolPolicy !== undefined ? { toolPolicy: body.toolPolicy } : {}),
    })
    .where(eq(mcpConnections.id, id));

  await db.insert(auditLog).values({
    tenantId: managed.tenant.id,
    actor: user.id,
    action: 'connection.update',
    target: managed.conn.name,
    detail: body,
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
