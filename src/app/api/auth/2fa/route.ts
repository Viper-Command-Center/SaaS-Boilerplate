/**
 * Two-factor auth (TOTP).
 *
 * GET    /api/auth/2fa            — current status
 * POST   /api/auth/2fa            — start enrolment: returns secret + otpauth URI
 * PUT    /api/auth/2fa {code}     — confirm the code, enable 2FA, return backup codes (once)
 * DELETE /api/auth/2fa {password} — disable 2FA (password required)
 */

import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { verifyPassword } from '@/libs/auth/password';
import { getCurrentUser } from '@/libs/auth/session';
import { generateBackupCodes, generateTotpSecret, otpauthUrl, verifyTotp } from '@/libs/auth/totp';
import { db } from '@/libs/DB';
import { users } from '@/models/Schema';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const backupCodes = Array.isArray(user.twoFactorBackupCodes) ? user.twoFactorBackupCodes.length : 0;
  return NextResponse.json({ enabled: user.twoFactorEnabled, backupCodesRemaining: backupCodes });
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (user.twoFactorEnabled) {
    return NextResponse.json({ error: 'Two-factor authentication is already enabled.' }, { status: 409 });
  }

  // Store the pending secret; it only becomes active once a code is confirmed.
  const secret = generateTotpSecret();
  await db.update(users).set({ twoFactorSecret: secret }).where(eq(users.id, user.id));

  return NextResponse.json({
    secret,
    otpauthUrl: otpauthUrl({ secret, email: user.email }),
  });
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!user.twoFactorSecret) {
    return NextResponse.json({ error: 'Start enrolment first.' }, { status: 400 });
  }

  let code = '';
  try {
    code = String((await request.json()).code ?? '');
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  if (!verifyTotp(user.twoFactorSecret, code)) {
    return NextResponse.json({ error: 'That code is not valid. Check your authenticator app and try again.' }, { status: 400 });
  }

  // Backup codes are shown ONCE and stored hashed.
  const codes = generateBackupCodes();
  const hashes = await Promise.all(codes.map(c => bcrypt.hash(c, 10)));

  await db
    .update(users)
    .set({ twoFactorEnabled: true, twoFactorBackupCodes: hashes })
    .where(eq(users.id, user.id));

  return NextResponse.json({ ok: true, backupCodes: codes });
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let password = '';
  try {
    password = String((await request.json()).password ?? '');
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 });
  }

  await db
    .update(users)
    .set({ twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: null })
    .where(eq(users.id, user.id));

  return NextResponse.json({ ok: true });
}
