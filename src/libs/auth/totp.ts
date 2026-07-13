/**
 * TOTP (RFC 6238) — authenticator-app 2FA using node:crypto only (no deps).
 * 6 digits, 30-second step, SHA-1 (what Google Authenticator / 1Password /
 * Authy expect). Accepts the previous and next step to tolerate clock drift.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DIGITS = 6;
const STEP_SECONDS = 30;
const DRIFT_STEPS = 1; // ±30s

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      continue;
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xFF);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** New random secret, base32 (what you paste into an authenticator app). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function codeForStep(secret: string, step: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  buf.writeUInt32BE(step >>> 0, 4);
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0F;
  const binary
    = ((hmac[offset]! & 0x7F) << 24)
      | ((hmac[offset + 1]! & 0xFF) << 16)
      | ((hmac[offset + 2]! & 0xFF) << 8)
      | (hmac[offset + 3]! & 0xFF);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/** Verify a 6-digit code, tolerating ±1 time step. */
export function verifyTotp(secret: string, code: string): boolean {
  const cleaned = (code ?? '').replace(/\D/g, '');
  if (cleaned.length !== DIGITS || !secret) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d++) {
    const expected = codeForStep(secret, now + d);
    const a = Buffer.from(expected);
    const b = Buffer.from(cleaned);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return true;
    }
  }
  return false;
}

/** otpauth:// URI — what the QR code encodes. */
export function otpauthUrl(a: { secret: string; email: string; issuer?: string }): string {
  const issuer = a.issuer ?? 'Artivio';
  const label = encodeURIComponent(`${issuer}:${a.email}`);
  const params = new URLSearchParams({
    secret: a.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** One-time backup codes (shown once, stored hashed). */
export function generateBackupCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString('hex').toUpperCase(); // 10 chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}
