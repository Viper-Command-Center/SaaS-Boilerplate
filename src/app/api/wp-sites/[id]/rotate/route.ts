/** POST /api/wp-sites/:id/rotate {tenantSlug} — rotate the application password (§3). */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guard, isResponse } from '@/libs/wpsites/access';
import { logSiteEvent } from '@/libs/wpsites/audit';
import { redactSecrets } from '@/libs/wpsites/redact';
import { rotateAppPassword } from '@/libs/wpsites/rotate';
import { getPublicSite, getResolvedSite } from '@/libs/wpsites/store';

export const dynamic = 'force-dynamic';

const Body = z.object({ tenantSlug: z.string().min(1).max(80) });

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
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
  const site = await getResolvedSite(g.tenant.id, id);
  if (!site) {
    return NextResponse.json({ error: 'Site not found.' }, { status: 404 });
  }
  try {
    const result = await rotateAppPassword(site, g.tenant.slug);
    await logSiteEvent(g.tenant.id, id, g.user.id, 'rotate', { name: result.name, revokedOld: result.revokedOld });
    return NextResponse.json({ ...result, site: await getPublicSite(g.tenant.id, id) });
  } catch (err) {
    return NextResponse.json({ error: redactSecrets(err instanceof Error ? err.message : 'Rotation failed.', [site.authSecret]) }, { status: 400 });
  }
}
