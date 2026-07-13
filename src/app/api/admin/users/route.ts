/**
 * GET  /api/admin/users — all users with their workspace memberships
 * PATCH /api/admin/users — toggle platform admin, or soft-delete a user
 * Platform admin only.
 */

import { desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { memberships, tenants, users } from '@/models/Schema';

export const dynamic = 'force-dynamic';

export async function GET() {
  const admin = await getCurrentUser();
  if (!admin?.isAdmin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(500);

  const mems = await db
    .select({
      userId: memberships.userId,
      role: memberships.role,
      tenantName: tenants.name,
      tenantSlug: tenants.slug,
    })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id));

  const byUser = new Map<string, Array<{ role: string; tenantName: string; tenantSlug: string }>>();
  for (const m of mems) {
    const list = byUser.get(m.userId) ?? [];
    list.push({ role: m.role, tenantName: m.tenantName, tenantSlug: m.tenantSlug });
    byUser.set(m.userId, list);
  }

  return NextResponse.json({
    users: rows.map(u => ({ ...u, memberships: byUser.get(u.id) ?? [] })),
  });
}

export async function PATCH(request: Request) {
  const admin = await getCurrentUser();
  if (!admin?.isAdmin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  let body: { userId?: string; isAdmin?: boolean; deleted?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  if (!body.userId) {
    return NextResponse.json({ error: 'userId required.' }, { status: 400 });
  }
  if (body.userId === admin.id) {
    return NextResponse.json({ error: 'You cannot modify your own account here.' }, { status: 400 });
  }

  await db
    .update(users)
    .set({
      ...(body.isAdmin !== undefined ? { isAdmin: Boolean(body.isAdmin) } : {}),
      ...(body.deleted !== undefined ? { deletedAt: body.deleted ? new Date() : null } : {}),
    })
    .where(eq(users.id, body.userId));

  return NextResponse.json({ ok: true });
}
