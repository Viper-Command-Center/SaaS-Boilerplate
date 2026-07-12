/**
 * Server-side session helpers. Ported from BudgetSmart.
 *
 * Strategy:
 *   - On login we create a row in `sessions` with a random `tokenId`.
 *   - The browser cookie holds a JWT (HS256 via jose) whose payload is
 *     { sid, uid } where sid === sessions.tokenId.
 *   - Middleware verifies the JWT is well-signed, then `getCurrentUser`
 *     hits the DB to confirm the row hasn't been revoked.
 *   - The DB lookup is the authoritative trust check; the JWT is only
 *     a tamper-resistant transport.
 *
 * SESSION_SECRET is read from process.env at call time (NOT via t3-env) so
 * the Next.js build never requires it — it only has to exist at runtime.
 */

import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import { cookies } from 'next/headers';

import { db } from '@/libs/DB';
import { sessions, users } from '@/models/Schema';

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'artivio_session';
const MAX_AGE_DAYS = Number.parseInt(process.env.SESSION_MAX_AGE_DAYS || '30', 10);
const MAX_AGE_SECONDS = MAX_AGE_DAYS * 24 * 60 * 60;

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('SESSION_SECRET must be set to a 32+ character random string');
  }
  return new TextEncoder().encode(raw);
}

export type SessionPayload = {
  sid: string;
  uid: string;
};

export async function signSessionJwt(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_DAYS}d`)
    .sign(secret());
}

export async function verifySessionJwt(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (typeof payload.sid === 'string' && typeof payload.uid === 'string') {
      return { sid: payload.sid, uid: payload.uid };
    }
    return null;
  } catch {
    return null;
  }
}

/** Creates a session row, sets the cookie, returns the JWT. */
export async function createSession(
  userId: string,
  meta?: { userAgent?: string; ip?: string },
) {
  const tokenId = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + MAX_AGE_SECONDS * 1000);
  await db.insert(sessions).values({
    userId,
    tokenId,
    userAgent: meta?.userAgent,
    ipAddress: meta?.ip,
    expiresAt,
  });
  const jwt = await signSessionJwt({ sid: tokenId, uid: userId });
  const jar = await cookies();
  jar.set(COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: MAX_AGE_SECONDS,
    path: '/',
  });
  return { jwt, tokenId, expiresAt };
}

export async function destroyCurrentSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  jar.delete(COOKIE_NAME);
  if (!token) {
    return;
  }
  const payload = await verifySessionJwt(token);
  if (!payload) {
    return;
  }
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.tokenId, payload.sid));
}

/**
 * Loads the current user from the request cookies. Returns null if
 * unauthenticated or if the session has been revoked / expired.
 */
export async function getCurrentUser() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }
  const payload = await verifySessionJwt(token);
  if (!payload) {
    return null;
  }

  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenId, payload.sid),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);

  return rows[0]?.user ?? null;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
