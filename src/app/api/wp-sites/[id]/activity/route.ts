/** GET /api/wp-sites/:id/activity?tenant=<slug>&limit=50 — per-site audit trail (§7). */

import { NextResponse } from 'next/server';
import { guard, isResponse } from '@/libs/wpsites/access';
import { listSiteActivity } from '@/libs/wpsites/audit';
import { getPublicSite } from '@/libs/wpsites/store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const g = await guard(url.searchParams.get('tenant') ?? '', 'read');
  if (isResponse(g)) {
    return g;
  }
  const site = await getPublicSite(g.tenant.id, id);
  if (!site) {
    return NextResponse.json({ error: 'Site not found.' }, { status: 404 });
  }
  const limit = Number(url.searchParams.get('limit') ?? 50);
  return NextResponse.json({ activity: await listSiteActivity(g.tenant.id, id, Number.isFinite(limit) ? limit : 50) });
}
