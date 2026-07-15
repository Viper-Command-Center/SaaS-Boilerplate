/**
 * Operator notifications — how a platform-level issue reaches Ryan.
 *
 * Ryan's rule: anything that could affect ALL clients (a platform bug) must get
 * human oversight, not a self-merged fix. So when the triage system escalates a
 * `platform`-class issue, it pings the operator here — by email always, and by
 * WhatsApp too when configured. Both channels are best-effort and never throw:
 * failing to notify must not break the request that triggered it.
 *
 * WhatsApp goes to Ryan's OWN number (OPERATOR_WHATSAPP_TO) — his consent by
 * definition — via the shared Twilio sender in libs/messaging/whatsapp.ts.
 */

import { sendEmail } from '@/libs/email';
import { sendOperatorWhatsApp, whatsappConfigured } from '@/libs/messaging/whatsapp';

/**
 * Notify the operator across every configured channel. Never throws.
 * `short` is the WhatsApp/alert line; `full` is the email body (the diagnostic
 * bundle). Email always fires; WhatsApp fires when configured.
 */
export async function notifyOperator(a: {
  subject: string;
  short: string;
  full: string;
}): Promise<void> {
  await Promise.allSettled([
    sendEmail({
      to: process.env.EMAIL_FROM || 'hello@artivio.ai',
      subject: a.subject.slice(0, 120),
      text: a.full,
      html: `<pre style="font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap">${
        a.full.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] ?? c))
      }</pre>`,
    }),
    sendOperatorWhatsApp(`🚨 ${a.subject}\n\n${a.short}\n\nSee the Issues inbox in Artivio admin for the full bundle.`),
  ]);
}

export function operatorChannels(): string[] {
  const channels = ['email'];
  if (whatsappConfigured() && process.env.OPERATOR_WHATSAPP_TO) {
    channels.push('whatsapp');
  }
  return channels;
}
