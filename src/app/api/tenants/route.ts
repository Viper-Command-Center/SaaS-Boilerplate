/**
 * GET  /api/tenants — workspaces the current user can access (with role)
 * POST /api/tenants — create a workspace (platform admin only)
 */

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { auditLog, memberships, tenants } from '@/models/Schema';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const list = await getUserTenants(user.id);
  return NextResponse.json({
    tenants: list.map(t => ({ id: t.id, name: t.name, slug: t.slug, vertical: t.vertical, role: t.role })),
    isAdmin: user.isAdmin,
  });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers and dashes only'),
  vertical: z.string().max(40).optional(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!user.isAdmin) {
    return NextResponse.json({ error: 'Only the platform admin can create workspaces.' }, { status: 403 });
  }

  let body: z.infer<typeof CreateSchema>;
  try {
    body = CreateSchema.parse(await request.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Invalid request.';
    return NextResponse.json({ error: msg ?? 'Invalid request.' }, { status: 400 });
  }

  const existing = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, body.slug)).limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ error: 'A workspace with this slug already exists.' }, { status: 409 });
  }

  const [tenant] = await db
    .insert(tenants)
    .values({ name: body.name.trim(), slug: body.slug, vertical: body.vertical?.trim() || null })
    .returning();
  if (!tenant) {
    return NextResponse.json({ error: 'Could not create the workspace.' }, { status: 500 });
  }

  await db.insert(memberships).values({ userId: user.id, tenantId: tenant.id, role: 'owner' });
  await db.insert(auditLog).values({
    tenantId: tenant.id,
    actor: user.id,
    action: 'tenant.create',
    target: tenant.slug,
  }).catch(() => {});

  return NextResponse.json({ ok: true, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } });
}
