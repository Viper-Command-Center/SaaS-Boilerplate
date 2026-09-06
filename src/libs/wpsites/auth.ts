/**
 * Credential → Authorization header. The ONLY place the word "Bearer" is
 * assembled for a WordPress site; the UI never shows it and the user never
 * types it (Phase 34 §4). See connection_config_traps: the prefix means
 * opposite things by connection type, so the platform owns it here.
 */

import type { AuthScheme } from '@/libs/wpsites/types';

/**
 * Users paste tokens copied from vendor UIs that already say "Bearer …", and
 * WordPress application passwords with their display spaces ("xxxx xxxx …").
 * Both are accepted and normalised, so the stored secret is always the RAW one.
 */
export function normaliseSecret(scheme: AuthScheme, raw: string): string {
  let s = (raw ?? '').trim();
  s = s.replace(/^bearer\s+/i, '');
  if (scheme === 'basic') {
    // WordPress itself strips whitespace from app passwords before comparing,
    // so either form authenticates — store the compact one.
    s = s.replace(/\s+/g, '');
  }
  return s;
}

export function buildAuthHeader(scheme: AuthScheme, user: string | null, secret: string): string {
  if (scheme === 'bearer') {
    return `Bearer ${secret}`;
  }
  const u = (user ?? '').trim();
  if (!u) {
    throw new Error('WordPress Sites: this site uses an application password but has no username.');
  }
  return `Basic ${Buffer.from(`${u}:${secret}`).toString('base64')}`;
}

/** The last four characters, the rest masked — for the Sites UI. */
export function maskSecret(secret: string): string {
  const tail = secret.slice(-4);
  return `${'•'.repeat(Math.max(8, Math.min(20, secret.length - 4)))}${tail}`;
}

/** Slug-safe label: lowercase, dashes, 2–60 chars. Used in tool arguments. */
export const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

export function normaliseLabel(raw: string): string {
  return (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** https://Example.com/ → https://example.com (no trailing slash, no path). */
export function normaliseSiteUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL((raw ?? '').trim());
  } catch {
    throw new Error('Site URL must be a full URL including https://.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('Site URL must start with https:// (or http:// for a local site).');
  }
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host.toLowerCase()}${path}`;
}
