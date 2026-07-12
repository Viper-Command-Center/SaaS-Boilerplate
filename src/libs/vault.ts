/**
 * Per-tenant credential vault — AES-256-GCM via node:crypto (no deps).
 *
 * Sealed format: base64( iv(12) | authTag(16) | ciphertext ).
 * Key: VAULT_MASTER_KEY env var, 64 hex chars (32 bytes). Read at call time
 * (NOT via t3-env) so builds never require it. Generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * Secrets are decrypted only at MCP call time and never logged or echoed.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function masterKey(): Buffer {
  const raw = process.env.VAULT_MASTER_KEY;
  if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error('VAULT_MASTER_KEY must be set to 64 hex characters (32 bytes). Add it to the Railway variables.');
  }
  return Buffer.from(raw, 'hex');
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function openSecret(sealed: string): string {
  const buf = Buffer.from(sealed, 'base64');
  if (buf.length < 12 + 16 + 1) {
    throw new Error('Sealed secret is malformed.');
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** True when the vault is usable in this environment. */
export function vaultConfigured(): boolean {
  return /^[0-9a-f]{64}$/i.test(process.env.VAULT_MASTER_KEY ?? '');
}
