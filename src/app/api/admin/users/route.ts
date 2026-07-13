/**
 * Platform-admin user management.
 *
 * GET    /api/admin/users            — all users + memberships + workspace list
 * POST   /api/admin/users            — create a user, optionally add to a workspace,
 *                                      email them an invite with a temp password
 * PATCH  /api/admin/users            — isAdmin, disable/restore, reset password,
 *                                      add/remove workspace membership
 * DELETE /api/admin/users?userId=…   — permanently delete a user
 */

import { and, desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { generatePassword, hashPassword } from '@/libs/auth/password';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { emailConfigured, sendInviteEmail } from '@/libs/email';
import { auditLog, memberships, tenants, users } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;

async function requireAdmin() {
  const user = await getCurrentUser();
  return user?.isAdmin ? user : null;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      isAdmin: users.isAdmin,
      twoFactorEnabled: users.twoFactorEnabled,
      createdAt: users.createdAt,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(500);

  const mems = await db
    .select({
      userId: memberships.userId,
      tenantId: memberships.tenantId,
      role: memberships.role,
      tenantName: tenants.name,
      tenantSlug: tenants.slug,
    })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id));

  const byUser = new Map<string, typeof mems>();
  for (const m of mems) {
    const list = byUser.get(m.userId) ?? [];
    list.push(m);
    byUser.set(m.userId, list);
  }

  const workspaces = await db
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .orderBy(tenants.name);

  return NextResponse.json({
    users: rows.map(u => ({ ...u, memberships: byUser.get(u.id) ?? [] })),
    workspaces,
    emailConfigured: emailConfigured(),
  });
}

const CreateSchema = z.object({
  email: z.string().email().max(254),
  firstName: z.string().max(80).optional(),
  isAdmin: z.boolean().optional(),
  tenantId: z.string().uuid().optional(),
  role: z.enum(ROLES).optional(),
  sendEmail: z.boolean().optional(),
});

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  let body: z.infer<typeof CreateSchema>;
  try {
    body = CreateSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const emailNormalized = body.email.trim().toLowerCase();
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.emailNormalized, emailNormalized)).limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ error: 'A user with this email already exists.' }, { status: 409 });
  }

  const tempPassword = generatePassword();
  const [user] = await db
    .insert(users)
    .values({
      email: body.email.trim(),
      emailNormalized,
      passwordHash: await hashPassword(tempPassword),
      firstName: body.firstName?.trim() || null,
      isAdmin: Boolean(body.isAdmin),
      mustChangePassword: true,
    })
    .returning({ id: users.id, email: users.email });

  if (!user) {
    return NextResponse.json({ error: 'Could not create the user.' }, { status: 500 });
  }

  let workspaceName: string | undefined;
  if (body.tenantId) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, body.tenantId)).limit(1);
    if (tenant) {
      workspaceName = tenant.name;
      await db.insert(memberships).values({
        userId: user.id,
        tenantId: tenant.id,
        role: body.role ?? 'viewer',
      });
    }
  }

  let emailed = false;
  if (body.sendEmail !== false) {
    emailed = await sendInviteEmail({
      to: user.email,
      firstName: body.firstName,
      tempPassword,
      workspaceName,
    });
  }

  await db.insert(auditLog).values({
    tenantId: body.tenantId ?? null,
    actor: admin.id,
    action: 'user.create',
    target: emailNormalized,
    detail: { emailed, role: body.role },
  }).catch(() => {});

  // The temp password is returned once so the admin can share it if email
  // isn't configured or delivery fails.
  return NextResponse.json({ ok: true, userId: user.id, tempPassword, emailed });
}

const PatchSchema = z.object({
  userId: z.string().uuid(),
  isAdmin: z.boolean().optional(),
  deleted: z.boolean().optional(),
  resetPassword: z.boolean().optional(),
  addMembership: z.object({ tenantId: z.string().uuid(), role: z.enum(ROLES) }).optional(),
  removeMembership: z.object({ tenantId: z.string().uuid() }).optional(),
});

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  let body: z.infer<typeof PatchSchema>;
  try {
    body = PatchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  if (body.userId === admin.id && (body.isAdmin === false || body.deleted === true)) {
    return NextResponse.json({ error: 'You cannot remove your own admin access.' }, { status: 400 });
  }

  if (body.isAdmin !== undefined || body.deleted !== undefined) {
    await db
      .update(users)
      .set({
        ...(body.isAdmin !== undefined ? { isAdmin: body.isAdmin } : {}),
        ...(body.deleted !== undefined ? { deletedAt: body.deleted ? new Date() : null } : {}),
      })
      .where(eq(users.id, body.userId));
  }

  let tempPassword: string | undefined;
  if (body.resetPassword) {
    tempPassword = generatePassword();
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(tempPassword), mustChangePassword: true })
      .where(eq(users.id, body.userId));
  }

  if (body.addMembership) {
    await db
      .insert(memberships)
      .values({
        userId: body.userId,
        tenantId: body.addMembership.tenantId,
        role: body.addMembership.role,
      })
      .onConflictDoUpdate({
        target: [memberships.userId, memberships.tenantId],
        set: { role: body.addMembership.role },
      });
  }

  if (body.removeMembership) {
    await db
      .delete(memberships)
      .where(and(
        eq(memberships.userId, body.userId),
        eq(memberships.tenantId, body.removeMembership.tenantId),
      ));
  }

  await db.insert(auditLog).values({
    actor: admin.id,
    action: 'user.update',
    target: body.userId,
    detail: { ...body, resetPassword: Boolean(body.resetPassword) },
  }).catch(() => {});

  return NextResponse.json({ ok: true, ...(tempPassword ? { tempPassword } : {}) });
}

export async function DELETE(request: Request) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }
  const userId = new URL(request.url).searchParams.get('userId') ?? '';
  if (!userId) {
    return NextResponse.json({ error: 'userId required.' }, { status: 400 });
  }
  if (userId === admin.id) {
    return NextResponse.json({ error: 'You cannot delete your own account.' }, { status: 400 });
  }

  await db.delete(users).where(eq(users.id, userId));
  await db.insert(auditLog).values({
    actor: admin.id,
    action: 'user.delete',
    target: userId,
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
