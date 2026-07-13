import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyPassword } from '@/libs/auth/password';
import { createSession } from '@/libs/auth/session';
import { verifyTotp } from '@/libs/auth/totp';
import { db } from '@/libs/DB';
import { users } from '@/models/Schema';

const BodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
  /** 6-digit TOTP code, or a backup code, when 2FA is enabled. */
  code: z.string().max(20).optional(),
});

export async function POST(request: Request) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const emailNormalized = body.email.trim().toLowerCase();
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.emailNormalized, emailNormalized))
    .limit(1);
  const user = rows[0];

  // Uniform error to avoid leaking which emails exist.
  const invalid = NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
  if (!user || user.deletedAt) {
    return invalid;
  }
  if (!(await verifyPassword(body.password, user.passwordHash))) {
    return invalid;
  }

  // ── Second factor ──
  if (user.twoFactorEnabled && user.twoFactorSecret) {
    if (!body.code) {
      // Password was right; the client should now ask for the 2FA code.
      return NextResponse.json({ twoFactorRequired: true }, { status: 401 });
    }

    const code = body.code.trim();
    let ok = verifyTotp(user.twoFactorSecret, code);

    // Fall back to a one-time backup code (each may be used once).
    if (!ok) {
      const hashes = Array.isArray(user.twoFactorBackupCodes)
        ? (user.twoFactorBackupCodes as string[])
        : [];
      const normalized = code.toUpperCase().replace(/\s/g, '');
      for (const hash of hashes) {
        // eslint-disable-next-line no-await-in-loop
        if (await bcrypt.compare(normalized, hash)) {
          ok = true;
          await db
            .update(users)
            .set({ twoFactorBackupCodes: hashes.filter(h => h !== hash) })
            .where(eq(users.id, user.id));
          break;
        }
      }
    }

    if (!ok) {
      return NextResponse.json({ error: 'Invalid authentication code.', twoFactorRequired: true }, { status: 401 });
    }
  }

  await createSession(user.id, {
    userAgent: request.headers.get('user-agent') ?? undefined,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
  });

  return NextResponse.json({ ok: true, mustChangePassword: user.mustChangePassword });
}
