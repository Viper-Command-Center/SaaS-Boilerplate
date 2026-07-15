/**
 * WhatsApp via Twilio — sending, receiving, and CONSENT.
 *
 * WhatsApp policy (and basic decency) requires opt-in before a business messages
 * someone, and honored opt-out. So the golden rule enforced here:
 *
 *   No message goes to a number without an active consent row
 *   (messaging_consents where opted_out_at IS NULL).
 *
 * `notifyOperator` (Ryan's own alerts) is the one exception — he's the account
 * owner configuring his own number, which is consent by definition.
 *
 * Twilio auth supports BOTH styles:
 *   · API Key (recommended):  TWILIO_API_KEY_SID (SK…) + TWILIO_API_KEY_SECRET
 *   · Auth Token (classic):   TWILIO_AUTH_TOKEN
 * Either way TWILIO_ACCOUNT_SID (AC…) is required — it's in the message URL.
 *   TWILIO_WHATSAPP_FROM   e.g. whatsapp:+14155238886
 */

import { Buffer } from 'node:buffer';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { messagingConsents } from '@/models/Schema';

type TwilioAuth = { accountSid: string; basic: string; from: string };

export function twilioConfig(): TwilioAuth | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID; // AC…
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!accountSid || !from) {
    return null;
  }
  // Prefer API Key auth; fall back to the classic Auth Token.
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySecret = process.env.TWILIO_API_KEY_SECRET;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  let basic: string;
  if (keySid && keySecret) {
    basic = Buffer.from(`${keySid}:${keySecret}`).toString('base64');
  } else if (authToken) {
    basic = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  } else {
    return null;
  }
  return { accountSid, basic, from };
}

export function whatsappConfigured(): boolean {
  return twilioConfig() !== null;
}

/** Normalize to a compact E.164-ish form for storage + matching. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  const withPlus = digits.startsWith('+') ? digits : `+${digits}`;
  return withPlus.replace(/(?!^)\+/g, ''); // only a leading +
}

/** Strip the whatsapp: prefix Twilio uses on To/From. */
export function bareNumber(v: string): string {
  return normalizePhone(v.replace(/^whatsapp:/i, ''));
}

// ─── Low-level send (no consent check — internal use only) ───────────────────
async function sendRaw(toWhatsApp: string, body: string): Promise<boolean> {
  const cfg = twilioConfig();
  if (!cfg) {
    return false;
  }
  const form = new URLSearchParams({
    From: cfg.from,
    To: toWhatsApp.startsWith('whatsapp:') ? toWhatsApp : `whatsapp:${normalizePhone(toWhatsApp)}`,
    Body: body.slice(0, 1500),
  });
  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${cfg.basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    },
  ).catch(() => null);
  return Boolean(resp?.ok);
}

/** Send to the operator's own number (no consent row needed — it's Ryan). */
export async function sendOperatorWhatsApp(body: string): Promise<void> {
  const to = process.env.OPERATOR_WHATSAPP_TO;
  if (!to || !whatsappConfigured()) {
    return;
  }
  await sendRaw(to, body).catch(() => {});
}

// ─── Consent ─────────────────────────────────────────────────────────────────

export async function hasActiveConsent(phone: string, channel = 'whatsapp'): Promise<boolean> {
  const [row] = await db
    .select({ id: messagingConsents.id })
    .from(messagingConsents)
    .where(and(
      eq(messagingConsents.phone, normalizePhone(phone)),
      eq(messagingConsents.channel, channel),
      isNull(messagingConsents.optedOutAt),
    ))
    .limit(1);
  return Boolean(row);
}

export async function recordConsent(a: {
  phone: string;
  consentText: string;
  channel?: string;
  source?: string;
  tenantId?: string | null;
  userId?: string | null;
}) {
  const phone = normalizePhone(a.phone);
  const [row] = await db
    .insert(messagingConsents)
    .values({
      phone,
      channel: a.channel ?? 'whatsapp',
      consentText: a.consentText.slice(0, 2000),
      source: (a.source ?? 'web-optin').slice(0, 40),
      tenantId: a.tenantId ?? null,
      userId: a.userId ?? null,
    })
    .returning();
  return row;
}

/** Reactivate the most recent consent row for a number (they replied START/YES). */
export async function reactivateConsent(phone: string, channel = 'whatsapp'): Promise<void> {
  const p = normalizePhone(phone);
  const [row] = await db
    .select({ id: messagingConsents.id })
    .from(messagingConsents)
    .where(and(eq(messagingConsents.phone, p), eq(messagingConsents.channel, channel)))
    .orderBy(desc(messagingConsents.createdAt))
    .limit(1);
  if (row) {
    await db.update(messagingConsents).set({ optedOutAt: null, confirmedAt: new Date() }).where(eq(messagingConsents.id, row.id));
  }
}

export async function optOut(phone: string, channel = 'whatsapp'): Promise<void> {
  await db
    .update(messagingConsents)
    .set({ optedOutAt: new Date() })
    .where(and(
      eq(messagingConsents.phone, normalizePhone(phone)),
      eq(messagingConsents.channel, channel),
      isNull(messagingConsents.optedOutAt),
    ));
}

/**
 * Send to an end-user — CONSENT-GATED. Returns why it didn't send, so callers
 * (and the agent) get an honest reason rather than a silent no-op.
 */
export async function sendWhatsAppToContact(phone: string, body: string): Promise<{ sent: boolean; reason?: string }> {
  if (!whatsappConfigured()) {
    return { sent: false, reason: 'WhatsApp is not configured on the platform.' };
  }
  if (!(await hasActiveConsent(phone))) {
    return { sent: false, reason: 'This number has not opted in to WhatsApp messages (or has opted out). They must opt in first.' };
  }
  const ok = await sendRaw(phone, body);
  return ok ? { sent: true } : { sent: false, reason: 'Twilio rejected the message.' };
}
