/**
 * Password hashing wrapper around bcryptjs.
 * Cost factor 12 is the 2026 baseline for online auth.
 * Ported from BudgetSmart.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const COST_FACTOR = 12;

/**
 * Generate a strong random password for admin-created accounts. Uses an
 * unambiguous alphabet (no 0/O/1/l/I). Shown once; never stored in plaintext.
 */
export function generatePassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*?';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST_FACTOR);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) {
    return false;
  }
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Returns human-readable problems with the password, empty if acceptable.
 * Intentionally permissive — NIST 800-63B (length over composition).
 */
export function validatePassword(plain: string): string[] {
  const errors: string[] = [];
  if (plain.length < 10) {
    errors.push('Password must be at least 10 characters.');
  }
  if (plain.length > 128) {
    errors.push('Password must be at most 128 characters.');
  }
  if (/^\s|\s$/.test(plain)) {
    errors.push('Password cannot start or end with whitespace.');
  }
  return errors;
}
