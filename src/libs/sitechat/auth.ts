/**
 * Site Chat authentication (Phase 46).
 *
 * The WordPress plugin (artivio-site-chat) proves WHICH SITE it is with a
 * per-site bearer token minted from the Sites panel. The token is random,
 * shown once, and stored hashed — the same discipline as password-reset
 * tokens. A token identifies a wp_sites row, which identifies the tenant; the
 * speaker (a WordPress user) is asserted by the plugin, which only forwards
 * logged-in users who hold its capability. So: token = site identity,
 * plugin = user identity, and the agent is pinned to that one site.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { tenants, wpSites } from '@/models/Schema';

export type SiteChatContext = {
  site: typeof wpSites.$inferSelect;
  tenant: typeof tenants.$inferSelect;
};

export function hashSiteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 32 random bytes, prefixed so a leaked value is recognisable in logs. */
export function mintSiteToken(): { token: string; hash: string } {
  const token = `asc_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashSiteToken(token) };
}

/** Resolve the bearer token on a request to its site + tenant, or null. */
export async function resolveSiteChat(request: Request): Promise<SiteChatContext | null> {
  const auth = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(asc_[\w-]{20,})$/i.exec(auth.trim());
  if (!m) {
    return null;
  }
  const hash = hashSiteToken(m[1]!);
  const [site] = await db
    .select()
    .from(wpSites)
    .where(and(eq(wpSites.chatTokenHash, hash), isNotNull(wpSites.chatTokenHash)))
    .limit(1);
  if (!site || !site.chatEnabled) {
    return null;
  }
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, site.tenantId)).limit(1);
  if (!tenant) {
    return null;
  }
  return { site, tenant };
}

/** The speaker, as the plugin asserts it. Bounded and normalised — it is display data and a conversation key, never authority. */
export type SiteChatUser = { id: string; name: string; role: string };

export function normaliseSiteUser(raw: unknown): SiteChatUser | null {
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : null;
  const id = String(r?.id ?? '').trim().replace(/[^\w.@-]/g, '').slice(0, 60);
  if (!id) {
    return null;
  }
  const name = String(r?.name ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 80) || 'the site owner';
  const role = String(r?.role ?? '').replace(/[^a-z_-]/gi, '').slice(0, 30) || 'editor';
  return { id, name, role };
}

export function externalKeyFor(user: SiteChatUser): string {
  return `wp:${user.id}`;
}
