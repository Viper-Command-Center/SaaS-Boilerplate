import { destroyCurrentSession } from '@/libs/auth/session';

/**
 * Ends the session and returns to the sign-in page.
 *
 * NOTE: we must NOT build an absolute URL from `request.url` — behind Railway's
 * proxy that resolves to the container's internal address (localhost:8080) and
 * the browser would follow it. A relative Location is proxy-safe.
 */
function backToSignIn(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      'Location': '/sign-in',
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST() {
  await destroyCurrentSession();
  return backToSignIn();
}

export async function GET() {
  await destroyCurrentSession();
  return backToSignIn();
}
