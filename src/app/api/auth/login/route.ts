import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyPassword } from '@/libs/auth/password';
import { createSession } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { users } from '@/models/Schema';

const BodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
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

  await createSession(user.id, {
    userAgent: request.headers.get('user-agent') ?? undefined,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
  });

  return NextResponse.json({ ok: true });
}
