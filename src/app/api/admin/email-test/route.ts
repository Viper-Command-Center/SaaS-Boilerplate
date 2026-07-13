/**
 * POST /api/admin/email-test — platform admin only.
 * Sends a test email and returns the PROVIDER'S ACTUAL ERROR, so email
 * problems (usually an unverified Postmark Sender Signature) are diagnosable
 * without digging through logs.
 */

import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/libs/auth/session';
import { appUrl, sendEmail } from '@/libs/email';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  let to = user.email;
  try {
    const body = await request.json();
    if (typeof body?.to === 'string' && body.to.includes('@')) {
      to = body.to;
    }
  } catch {
    // use the admin's own address
  }

  const result = await sendEmail({
    to,
    subject: 'Artivio email test',
    html: `<p>This is a test from your Artivio Command Center.</p><p>If you're reading this, transactional email works.</p><p><a href="${appUrl()}">${appUrl()}</a></p>`,
    text: `Artivio email test — if you're reading this, transactional email works. ${appUrl()}`,
  });

  return NextResponse.json({
    ok: result.ok,
    to,
    from: process.env.EMAIL_FROM || 'hello@artivio.ai',
    error: result.error,
    hint: result.ok
      ? undefined
      : 'Most common cause: the From address is not a verified Sender Signature in Postmark (Postmark → Sender Signatures), or the server token is for a different Postmark server. You can also set EMAIL_FROM to an address you have verified.',
  }, { status: result.ok ? 200 : 502 });
}
