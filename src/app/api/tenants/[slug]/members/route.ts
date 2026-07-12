/**
 * GET    /api/tenants/[slug]/members — list members (owner/admin)
 * POST   /api/tenants/[slug]/members — add a member by email. If the user
 *        doesn't exist yet, an account is created with a generated password
 *        that is returned ONCE for the admin to share securely.
 * DELETE /api/tenants/[slug]/members?userId=… — remove a member
 */

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { generatePassword, hashPassword } from '@/libs/auth/password';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { auditLog, memberships, users } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const MANAGER_ROLES = ['owner', 'admin'];
const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;

async function requireManagedTenant(userId: string, isAdmin: boolean, slug: string) {
  const tenant = (await getUserTenants(userId)).find(t => t.slug === slug);
  if (!tenant) {
    return null;
  }
  if (!isAdmin && !MANAGER_ROLES.includes(tenant.role)) {
    return null;
  }
  return tenant;
}

export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { slug } = await ctx.params;
  const tenant = await requireManagedTenant(user.id, user.isAdmin, slug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access.' }, { status: 403 });
  }

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      firstName: users.firstName,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.tenantId, tenant.id));

  return NextResponse.json({ members: rows });
}

const AddSchema = z.object({
  email: z.string().email().max(254),
  firstName: z.string().max(80).optional(),
  role: z.enum(ROLES),
});

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { slug } = await ctx.params;
  const tenant = await requireManagedTenant(user.id, user.isAdmin, slug);
  if (!tenant) {
    return NextResponse.json({ error: 'You need owner/admin access to manage members.' }, { status: 403 });
  }

  let body: z.infer<typeof AddSchema>;
  try {
    body = AddSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const emailNormalized = body.email.trim().toLowerCase();
  let [member] = await db.select().from(users).where(eq(users.emailNormalized, emailNormalized)).limit(1);

  let generatedPassword: string | undefined;
  if (!member) {
    generatedPassword = generatePassword();
    [member] = await db
      .insert(users)
      .values({
        email: body.email.trim(),
        emailNormalized,
        passwordHash: await hashPassword(generatedPassword),
        firstName: body.firstName?.trim() || null,
      })
      .returning();
  }
  if (!member) {
    return NextResponse.json({ error: 'Could not create the account.' }, { status: 500 });
  }

  const existing = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, member.id), eq(memberships.tenantId, tenant.id)))
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ error: 'Already a member of this workspace.' }, { status: 409 });
  }

  await db.insert(memberships).values({ userId: member.id, tenantId: tenant.id, role: body.role });
  await db.insert(auditLog).values({
    tenantId: tenant.id,
    actor: user.id,
    action: 'member.add',
    target: emailNormalized,
    detail: { role: body.role },
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    member: { userId: member.id, email: member.email, role: body.role },
    // Returned exactly once so the admin can hand it to the client. The hash
    // is what's stored; this value is never retrievable again.
    ...(generatedPassword ? { generatedPassword } : {}),
  });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { slug } = await ctx.params;
  const tenant = await requireManagedTenant(user.id, user.isAdmin, slug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access.' }, { status: 403 });
  }

  const userId = new URL(request.url).searchParams.get('userId') ?? '';
  if (!userId) {
    return NextResponse.json({ error: 'userId required.' }, { status: 400 });
  }
  if (userId === user.id) {
    return NextResponse.json({ error: 'You cannot remove yourself.' }, { status: 400 });
  }

  await db
    .delete(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenant.id)));
  await db.insert(auditLog).values({
    tenantId: tenant.id,
    actor: user.id,
    action: 'member.remove',
    target: userId,
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
