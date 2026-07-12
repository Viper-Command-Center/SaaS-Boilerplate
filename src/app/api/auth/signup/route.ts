import { count, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { hashPassword, validatePassword } from '@/libs/auth/password';
import { createSession } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { users } from '@/models/Schema';

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

  // The first user ever created becomes the platform admin.
  const [{ total }] = await db.select({ total: count() }).from(users) as [{ total: number }];

  const [user] = await db
    .insert(users)
    .values({
      email: body.email.trim(),
      emailNormalized,
      passwordHash: await hashPassword(body.password),
      firstName: body.firstName?.trim() || null,
      lastName: body.lastName?.trim() || null,
      isAdmin: Number(total) === 0,
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
