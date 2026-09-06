/** POST /api/wp-sites/:id/test {tenantSlug, writeProbe?} — the Test button. */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { fail, guard, isResponse } from '@/libs/wpsites/access';
import { logSiteEvent } from '@/libs/wpsites/audit';
import { runSiteTest } from '@/libs/wpsites/discovery';
import { getPublicSite } from '@/libs/wpsites/store';

export const dynamic = 'force-dynamic';

const Body = z.object({ tenantSlug: z.string().min(1).max(80), writeProbe: z.boolean().optional() });

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
  try {
    const report = await runSiteTest(g.tenant.id, id, { writeProbe: body.writeProbe === true });
    await logSiteEvent(g.tenant.id, id, g.user.id, 'test', { status: report.status, writeProbe: body.writeProbe === true });
    return NextResponse.json({ report, site: await getPublicSite(g.tenant.id, id) });
  } catch (err) {
    return fail(err, /not found/i.test(err instanceof Error ? err.message : '') ? 404 : 400);
  }
}
