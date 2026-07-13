/**
 * Transactional email via Postmark (fetch, no SDK).
 *
 * Env:
 *   POSTMARK_SERVER_TOKEN — server token
 *   EMAIL_FROM            — verified sender (default hello@artivio.ai)
 *   PRODUCTION_URL        — used to build links (default https://artivio.ai)
 *
 * Sending never throws: an email failure must not break account creation.
 */

const FROM = process.env.EMAIL_FROM || 'hello@artivio.ai';

export function appUrl(): string {
  return (process.env.PRODUCTION_URL || 'https://artivio.ai').replace(/\/$/, '');
}

export function emailConfigured(): boolean {
  return Boolean(process.env.POSTMARK_SERVER_TOKEN);
}

async function send(a: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<boolean> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) {
    return false;
  }
  try {
    const resp = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Postmark-Server-Token': token,
      },
      body: JSON.stringify({
        From: FROM,
        To: a.to,
        Subject: a.subject,
        HtmlBody: a.html,
        TextBody: a.text,
        MessageStream: 'outbound',
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function shell(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px">
    <div style="font-weight:800;font-size:18px;margin-bottom:24px">Artivio</div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
      <h1 style="margin:0 0 12px;font-size:20px">${title}</h1>
      ${body}
    </div>
    <p style="margin-top:24px;font-size:12px;color:#64748b">Artivio — AI Command Center · <a href="mailto:hello@artivio.ai" style="color:#64748b">hello@artivio.ai</a></p>
  </div></body></html>`;
}

/** Sent when an admin creates an account for a client. */
export async function sendInviteEmail(a: {
  to: string;
  firstName?: string | null;
  tempPassword: string;
  workspaceName?: string;
}): Promise<boolean> {
  const url = `${appUrl()}/sign-in`;
  const hello = a.firstName ? `Hi ${a.firstName},` : 'Hi,';
  const where = a.workspaceName ? ` for <strong>${a.workspaceName}</strong>` : '';

  return send({
    to: a.to,
    subject: 'Your Artivio account is ready',
    html: shell('Your Artivio workspace is ready', `
      <p>${hello}</p>
      <p>An Artivio Command Center account has been created for you${where}. Sign in with:</p>
      <p style="background:#f1f5f9;border-radius:8px;padding:12px;font-family:ui-monospace,monospace;font-size:14px">
        <strong>Email:</strong> ${a.to}<br/>
        <strong>Temporary password:</strong> ${a.tempPassword}
      </p>
      <p><a href="${url}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Sign in to Artivio</a></p>
      <p style="font-size:13px;color:#64748b">Please change your password after your first sign-in. If you weren't expecting this, you can ignore this email.</p>
    `),
    text: `${hello}\n\nAn Artivio account has been created for you.\n\nEmail: ${a.to}\nTemporary password: ${a.tempPassword}\n\nSign in: ${url}\n\nPlease change your password after signing in.`,
  });
}

/** Password reset link (token valid ~1 hour). */
export async function sendPasswordResetEmail(a: {
  to: string;
  token: string;
}): Promise<boolean> {
  const url = `${appUrl()}/reset-password?token=${encodeURIComponent(a.token)}`;
  return send({
    to: a.to,
    subject: 'Reset your Artivio password',
    html: shell('Reset your password', `
      <p>We received a request to reset your Artivio password. This link expires in one hour.</p>
      <p><a href="${url}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Choose a new password</a></p>
      <p style="font-size:13px;color:#64748b">If you didn't request this, ignore this email — your password won't change.</p>
    `),
    text: `Reset your Artivio password (link expires in 1 hour):\n\n${url}\n\nIf you didn't request this, ignore this email.`,
  });
}

/** Waitlist / contact notification to the team. */
export async function sendAdminNotice(a: { subject: string; body: string }): Promise<boolean> {
  return send({
    to: FROM,
    subject: a.subject,
    html: shell(a.subject, `<p>${a.body}</p>`),
    text: a.body,
  });
}
