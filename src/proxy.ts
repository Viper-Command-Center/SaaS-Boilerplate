/**
 * Edge middleware — i18n routing + a CHEAP auth gate for /dashboard.
 * Verifies the session cookie's JWT signature only; route handlers and
 * layouts still call getCurrentUser() to do the authoritative DB check.
 * (No DB access here — Edge runtime.)
 */
import type { NextFetchEvent, NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import createMiddleware from 'next-intl/middleware';
import { NextResponse } from 'next/server';
import { routing } from './libs/I18nRouting';

const handleI18nRouting = createMiddleware(routing);

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'artivio_session';

const PROTECTED = /^(?:\/[a-z]{2})?\/(?:dashboard|onboarding)(?:\/|$)/;

async function hasValidSessionCookie(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  const rawSecret = process.env.SESSION_SECRET;
  if (!token || !rawSecret || rawSecret.length < 32) {
    return false;
  }
  try {
    await jwtVerify(token, new TextEncoder().encode(rawSecret));
    return true;
  } catch {
    return false;
  }
}

export default async function proxy(
  request: NextRequest,
  _event: NextFetchEvent,
) {
  const { pathname } = request.nextUrl;

  // Authenticated API responses are user-specific — never let the browser
  // cache them. Routes self-gate via getCurrentUser().
  if (pathname.startsWith('/api/')) {
    const response = NextResponse.next();
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }

  if (PROTECTED.test(pathname)) {
    if (!(await hasValidSessionCookie(request))) {
      const locale = pathname.match(/^\/([a-z]{2})\//)?.[1];
      const signInUrl = new URL(locale ? `/${locale}/sign-in` : '/sign-in', request.url);
      return NextResponse.redirect(signInUrl);
    }
  }

  return handleI18nRouting(request);
}

export const config = {
  // Match all pathnames except for
  // - … if they start with `/_next`, `/_vercel` or `monitoring`
  // - … the ones containing a dot (e.g. `favicon.ico`)
  matcher: '/((?!_next|_vercel|monitoring|.*\\..*).*)',
};
