/**
 * Application-password rotation — fully automated, zero downtime (§3).
 *
 *  1. introspect  → which app password we are currently using (its uuid)
 *  2. create      → a new one named artivio-<workspace>-<date>
 *  3. verify      → users/me with the NEW secret must answer 200
 *  4. store       → the vault now holds the new secret
 *  5. delete old  → by uuid, authenticated with the NEW secret
 *
 * Order matters: the new secret is persisted BEFORE the old one is revoked,
 * so a crash between 4 and 5 leaves two working passwords, never zero.
 */

import type { ResolvedSite } from '@/libs/wpsites/types';
import { explainRestFailure, restRequest } from '@/libs/wpsites/channels';
import { replaceSiteSecret } from '@/libs/wpsites/store';

export type RotateResult = { name: string; uuid: string; revokedOld: boolean; note?: string };

export async function rotateAppPassword(site: ResolvedSite, tenantSlug: string): Promise<RotateResult> {
  if (site.authScheme !== 'basic') {
    throw new Error('Rotate applies to application passwords only — this site uses a custom token, which is re-issued in the site plugin.');
  }

  // 1. Which one are we?
  let oldUuid = site.appPasswordUuid;
  const intro = await restRequest(site, 'GET', '/wp/v2/users/me/application-passwords/introspect');
  if (intro.ok && typeof intro.body === 'object' && intro.body && typeof (intro.body as { uuid?: string }).uuid === 'string') {
    oldUuid = (intro.body as { uuid: string }).uuid;
  }

  // 2. Create.
  const name = `artivio-${tenantSlug}-${new Date().toISOString().slice(0, 10)}`.slice(0, 100);
  const created = await restRequest(site, 'POST', '/wp/v2/users/me/application-passwords', { name });
  if (!created.ok) {
    throw new Error(explainRestFailure(site, created, '/wp/v2/users/me/application-passwords'));
  }
  const body = created.body as { password?: string; uuid?: string };
  if (!body.password || !body.uuid) {
    throw new Error('WordPress did not return a new application password — the user may lack permission, or Application Passwords are disabled on this site.');
  }

  // 3. Verify with the new secret before touching anything else.
  const probe: ResolvedSite = { ...site, authSecret: body.password.replace(/\s+/g, ''), appPasswordUuid: body.uuid };
  const me = await restRequest(probe, 'GET', '/wp/v2/users/me?context=edit');
  if (!me.ok) {
    // Roll back the half-made state: revoke what we just created (with the OLD secret, still valid).
    await restRequest(site, 'DELETE', `/wp/v2/users/me/application-passwords/${body.uuid}`).catch(() => {});
    throw new Error(`The new application password did not authenticate (HTTP ${me.status}); the old one is unchanged.`);
  }

  // 4. Persist.
  await replaceSiteSecret(site.tenantId, site.id, body.password, body.uuid);

  // 5. Revoke the old one — best effort, reported honestly.
  let revokedOld = false;
  let note: string | undefined;
  if (oldUuid && oldUuid !== body.uuid) {
    const del = await restRequest(probe, 'DELETE', `/wp/v2/users/me/application-passwords/${oldUuid}`);
    revokedOld = del.ok;
    if (!del.ok) {
      note = `New password is live, but the old one (${oldUuid}) could not be revoked (HTTP ${del.status}) — remove it in WP Admin → Users → Profile → Application Passwords.`;
    }
  } else {
    note = 'New password is live. The previous one could not be identified (introspect unsupported on this WordPress) — revoke stale entries in WP Admin → Users → Profile → Application Passwords.';
  }
  return { name, uuid: body.uuid, revokedOld, note };
}
