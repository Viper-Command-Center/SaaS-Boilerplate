import { count, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { hashPassword, validatePassword } from '@/libs/auth/password';
import { createSession } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { users } from '@/models/Schema';

/**
 * Artivio is INVITE-ONLY. Public signup is disabled unless
 * ALLOW_PUBLIC_SIGNUP=true. The single exception is bootstrap: if no user
 * exists yet, the first signup creates the platform admin (so the platform can
 * never lock itself out). Everyone else is created by an admin in the console,
 * which emails them an invite.
 */
const BodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
  firstName: z.string().max(80).optional(),
  lastName: z.string().max(80).optional(),
});

export async function POST(request: Request) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  // The first user ever created becomes the platform admin (bootstrap).
  const [{ total }] = await db.select({ total: count() }).from(users) as [{ total: number }];
  const isBootstrap = Number(total) === 0;
  const publicSignupAllowed = process.env.ALLOW_PUBLIC_SIGNUP === 'true';

  if (!isBootstrap && !publicSignupAllowed) {
    return NextResponse.json(
      { error: 'Artivio is invite-only right now. Join the waitlist at hello@artivio.ai and we\'ll set up your workspace.' },
      { status: 403 },
    );
  }

  const passwordErrors = validatePassword(body.password);
  if (passwordErrors.length > 0) {
    return NextResponse.json({ error: passwordErrors.join(' ') }, { status: 400 });
  }

  const emailNormalized = body.email.trim().toLowerCase();

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailNormalized, emailNormalized))
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ error: 'An account with this email already exists.' }, { status: 409 });
  }

  const [user] = await db
    .insert(users)
    .values({
      email: body.email.trim(),
      emailNormalized,
      passwordHash: await hashPassword(body.password),
      firstName: body.firstName?.trim() || null,
      lastName: body.lastName?.trim() || null,
      isAdmin: isBootstrap,
    })
    .returning();

  if (!user) {
    return NextResponse.json({ error: 'Could not create the account.' }, { status: 500 });
  }

  await createSession(user.id, {
    userAgent: request.headers.get('user-agent') ?? undefined,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
  });

  return NextResponse.json({ ok: true });
}

/** Tells the sign-up page whether to show the form or the waitlist message. */
export async function GET() {
  const [{ total }] = await db.select({ total: count() }).from(users) as [{ total: number }];
  return NextResponse.json({
    open: Number(total) === 0 || process.env.ALLOW_PUBLIC_SIGNUP === 'true',
  });
}
