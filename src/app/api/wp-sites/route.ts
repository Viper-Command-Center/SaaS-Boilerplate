/**
 * WordPress Sites (Phase 34).
 *
 * GET  /api/wp-sites?tenant=<slug>          — sites (secrets masked), SSH keys
 *                                             (public halves), legacy connections
 *                                             still importable
 * POST /api/wp-sites  {tenantSlug, ...site}  — create a site, then run
 *                                             discovery+test and return the report
 * Members read; owners/admins write.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { fail, guard, isResponse } from '@/libs/wpsites/access';
import { logSiteEvent } from '@/libs/wpsites/audit';
import { runSiteTest } from '@/libs/wpsites/discovery';
import { findLegacyConnections } from '@/libs/wpsites/legacy';
import { createSite, getPublicSite, listSites, listSshKeys } from '@/libs/wpsites/store';

export const dynamic = 'force-dynamic';

const SiteBody = z.object({
  tenantSlug: z.string().min(1).max(80),
  label: z.string().min(1).max(80),
  siteUrl: z.string().min(1).max(500),
  authScheme: z.enum(['basic', 'bearer']).optional(),
  authUser: z.string().max(120).nullable().optional(),
  authSecret: z.string().max(4000).optional(),
  isDefault: z.boolean().optional(),
  ssh: z.object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).optional(),
    user: z.string().min(1).max(120),
    path: z.string().min(1).max(1000),
    keyId: z.string().uuid().nullable(),
  }).nullable().optional(),
  policy: z.object({
    rest: z.enum(['auto', 'ask', 'blocked']).optional(),
    mcp: z.enum(['auto', 'ask', 'blocked']).optional(),
    cli: z.enum(['auto', 'ask', 'blocked']).optional(),
  }).optional(),
  /** Skip the automatic test after saving (the UI runs it explicitly). */
  skipTest: z.boolean().optional(),
});

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  const g = await guard(slug, 'read');
  if (isResponse(g)) {
    return g;
  }
  const [sites, sshKeys, legacy] = await Promise.all([
    listSites(g.tenant.id),
    listSshKeys(g.tenant.id),
    findLegacyConnections(g.tenant.id).catch(() => []),
  ]);
  return NextResponse.json({ sites, sshKeys, legacy, canManage: g.user.isAdmin || ['owner', 'admin'].includes(g.tenant.role) });
}

export async function POST(request: Request) {
  let body: z.infer<typeof SiteBody>;
  try {
    body = SiteBody.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const g = await guard(body.tenantSlug, 'manage');
  if (isResponse(g)) {
    return g;
  }
  try {
    const site = await createSite(g.tenant.id, body);
    await logSiteEvent(g.tenant.id, site.id, g.user.id, 'create', { label: site.label, siteUrl: site.siteUrl });
    if (body.skipTest) {
      return NextResponse.json({ site });
    }
    const report = await runSiteTest(g.tenant.id, site.id).catch(() => null);
    await logSiteEvent(g.tenant.id, site.id, g.user.id, 'test', { status: report?.status ?? 'error' });
    return NextResponse.json({ site: await getPublicSite(g.tenant.id, site.id), report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/wp_sites_tenant_label_uq|duplicate key/i.test(msg)) {
      return NextResponse.json({ error: 'A site with that label already exists in this workspace.' }, { status: 409 });
    }
    return fail(err);
  }
}
