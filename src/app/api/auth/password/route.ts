/**
 * Password management.
 *
 * PUT  /api/auth/password  {currentPassword, newPassword} — change own password
 * POST /api/auth/password  {email}                        — request a reset link
 * PATCH /api/auth/password {token, newPassword}           — complete the reset
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { hashPassword, validatePassword, verifyPassword } from '@/libs/auth/password';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { sendPasswordResetEmail } from '@/libs/email';
import { passwordResetTokens, users } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** Change own password (signed in). */
export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  if (!(await verifyPassword(String(body.currentPassword ?? ''), user.passwordHash))) {
    return NextResponse.json({ error: 'Your current password is incorrect.' }, { status: 401 });
  }
  const newPassword = String(body.newPassword ?? '');
  const errors = validatePassword(newPassword);
  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(' ') }, { status: 400 });
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: false })
    .where(eq(users.id, user.id));

  return NextResponse.json({ ok: true });
}

/** Request a reset link. Always returns ok (never reveals whether an account exists). */
export async function POST(request: Request) {
  let email = '';
  try {
    email = String((await request.json()).email ?? '').trim().toLowerCase();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  if (!z.string().email().safeParse(email).success) {
    return NextResponse.json({ ok: true });
  }

  const [user] = await db.select().from(users).where(eq(users.emailNormalized, email)).limit(1);
  if (user && !user.deletedAt) {
    const token = randomBytes(32).toString('hex');
    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
    });
    await sendPasswordResetEmail({ to: user.email, token });
  }

  return NextResponse.json({ ok: true });
}

/** Complete a reset with the emailed token. */
export async function PATCH(request: Request) {
  let body: { token?: string; newPassword?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const token = String(body.token ?? '');
  const newPassword = String(body.newPassword ?? '');
  const errors = validatePassword(newPassword);
  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(' ') }, { status: 400 });
  }

  const [row] = await db
    .select()
    .from(passwordResetTokens)
    .where(and(
      eq(passwordResetTokens.tokenHash, hashToken(token)),
      isNull(passwordResetTokens.usedAt),
      gt(passwordResetTokens.expiresAt, new Date()),
    ))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: 'This reset link is invalid or has expired.' }, { status: 400 });
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: false })
    .where(eq(users.id, row.userId));
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.id, row.id));

  return NextResponse.json({ ok: true });
}
