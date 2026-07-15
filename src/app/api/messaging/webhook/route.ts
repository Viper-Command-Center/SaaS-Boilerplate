/**
 * POST /api/messaging/webhook — Twilio inbound WhatsApp webhook.
 *
 * Twilio posts application/x-www-form-urlencoded with From, Body, etc. whenever
 * someone messages the WhatsApp number. Right now this handles the COMPLIANCE
 * keywords, which is what makes opt-out real:
 *   STOP / UNSUBSCRIBE / CANCEL / END / QUIT → opt out, confirm, send nothing more
 *   START / YES / UNSTOP                      → re-subscribe / confirm opt-in
 *   HELP / INFO                               → what this is + how to opt out
 *
 * (Full two-way agent chat over WhatsApp is the next slice; this webhook is the
 * consent backbone it will build on.)
 *
 * We reply with TwiML (an XML <Response>) so Twilio speaks the confirmation.
 */

import { bareNumber, optOut, reactivateConsent } from '@/libs/messaging/whatsapp';

export const dynamic = 'force-dynamic';

function twiml(message?: string): Response {
  const body = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${
      message.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] ?? c))
    }</Message></Response>`
    : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  return new Response(body, { headers: { 'Content-Type': 'text/xml' } });
}

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'cancel', 'end', 'quit', 'stopall']);
const START_WORDS = new Set(['start', 'yes', 'unstop', 'subscribe']);
const HELP_WORDS = new Set(['help', 'info']);

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const from = String(form?.get('From') ?? '');
  const text = String(form?.get('Body') ?? '').trim().toLowerCase();

  if (!from) {
    return twiml();
  }
  const phone = bareNumber(from);

  // Opt-out — honored immediately. This is the promise both legal pages make.
  if (STOP_WORDS.has(text)) {
    await optOut(phone).catch(() => {});
    return twiml('You\'ve opted out and will no longer receive WhatsApp messages from Artivio. Reply START to resubscribe.');
  }

  // Opt back in / confirm a pending double opt-in.
  if (START_WORDS.has(text)) {
    await reactivateConsent(phone).catch(() => {});
    return twiml('You\'re subscribed to WhatsApp messages from your Artivio assistant. Reply STOP at any time to opt out.');
  }

  if (HELP_WORDS.has(text)) {
    return twiml('Artivio: your AI assistant sends you updates and replies here. Reply STOP to opt out. Support: hello@artivio.ai');
  }

  // Any other inbound message: acknowledge for now. (Two-way agent chat lands
  // here next — route the message into the tenant's agent loop and reply.)
  return twiml();
}
