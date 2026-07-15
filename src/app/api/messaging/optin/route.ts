/**
 * POST /api/messaging/optin — public. Records a person's consent to receive
 * WhatsApp messages and (if Twilio is live) sends a confirmation asking them to
 * reply YES. This is the opt-in half of WhatsApp compliance.
 *
 * Public on purpose: WhatsApp's own opt-in guidance allows collecting consent on
 * a web page, and it lets anyone (including a client or a reviewer) subscribe.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  normalizePhone,
  recordConsent,
  sendWhatsAppToContact,
  whatsappConfigured,
} from '@/libs/messaging/whatsapp';

export const dynamic = 'force-dynamic';

// The exact wording the person agrees to — stored verbatim as consent evidence.
export const CONSENT_TEXT
  = 'I agree to receive WhatsApp messages from my Artivio AI assistant, including '
    + 'updates, approval requests, and replies to my messages. Message and data '
    + 'rates may apply. Reply STOP at any time to opt out, HELP for help.';

const Schema = z.object({
  phone: z.string().min(6).max(24),
  consent: z.literal(true), // must be an affirmative, un-prechecked action
  name: z.string().max(120).optional(),
});

export async function POST(request: Request) {
  let body: z.infer<typeof Schema>;
  try {
    body = Schema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: 'Please enter a valid phone number and tick the consent box.' },
      { status: 400 },
    );
  }

  const phone = normalizePhone(body.phone);
  if (phone.replace(/\D/g, '').length < 8) {
    return NextResponse.json({ error: 'That phone number does not look valid. Use international format, e.g. +15551234567.' }, { status: 400 });
  }

  await recordConsent({
    phone,
    consentText: CONSENT_TEXT,
    source: 'web-optin',
  });

  // Double opt-in: confirm via WhatsApp when configured. The confirmation itself
  // needs the consent row we just wrote, which sendWhatsAppToContact checks.
  let confirmationSent = false;
  if (whatsappConfigured()) {
    const res = await sendWhatsAppToContact(
      phone,
      'You\'re subscribed to WhatsApp messages from your Artivio assistant. Reply YES to confirm, or STOP to opt out.',
    ).catch(() => ({ sent: false }));
    confirmationSent = res.sent;
  }

  return NextResponse.json({
    ok: true,
    confirmationSent,
    message: confirmationSent
      ? 'Thanks! Check WhatsApp and reply YES to confirm.'
      : 'Thanks! Your preference has been saved. We\'ll message you on WhatsApp once messaging is live.',
  });
}
