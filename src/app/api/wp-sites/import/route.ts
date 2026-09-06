/**
 * POST /api/wp-sites/import
 *   {tenantSlug, legacy: true}            — import the workspace's old
 *                                           `wordpress` + `wpcli` connections
 *                                           into wp_sites and disable them (§2)
 *   {tenantSlug, provisioning: "<json>"}  — "Add site from provisioning token":
 *                                           paste the JSON the site's
 *                                           provision-agent hook returned (§8)
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { fail, guard, isResponse } from '@/libs/wpsites/access';
import { logSiteEvent } from '@/libs/wpsites/audit';
import { runSiteTest } from '@/libs/wpsites/discovery';
import { addSiteFromProvisioning, importLegacyConnections, parseProvisioningPayload } from '@/libs/wpsites/legacy';
import { getPublicSite } from '@/libs/wpsites/store';

export const dynamic = 'force-dynamic';

const Body = z.object({
  tenantSlug: z.string().min(1).max(80),
  legacy: z.boolean().optional(),
  provisioning: z.string().max(4000).optional(),
});

export async function POST(request: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const g = await guard(body.tenantSlug, 'manage');
  if (isResponse(g)) {
    return g;
  }
  try {
    if (body.legacy) {
      const summary = await importLegacyConnections(g.tenant.id, g.tenant.slug);
      for (const s of summary.created) {
        await logSiteEvent(g.tenant.id, s.id, g.user.id, 'import', { from: 'legacy', label: s.label });
      }
      return NextResponse.json({ summary });
    }
    if (body.provisioning) {
      const payload = parseProvisioningPayload(body.provisioning);
      const site = await addSiteFromProvisioning(g.tenant.id, payload);
      await logSiteEvent(g.tenant.id, site.id, g.user.id, 'import', { from: 'provisioning', label: site.label });
      const report = await runSiteTest(g.tenant.id, site.id).catch(() => null);
      return NextResponse.json({ site: await getPublicSite(g.tenant.id, site.id), report });
    }
    return NextResponse.json({ error: 'Nothing to import — pass legacy:true or a provisioning JSON.' }, { status: 400 });
  } catch (err) {
    return fail(err);
  }
}
