/**
 * GET /api/panels?tenant=<slug> — dashboard panels with their data resolved
 * server-side (dataset rows for kpi/timeseries/table panels).
 */

import { and, asc, desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { dashboardPanels, datasets } from '@/models/Schema';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  const tenant = (await getUserTenants(user.id)).find(t => t.slug === slug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }

  const panels = await db
    .select()
    .from(dashboardPanels)
    .where(eq(dashboardPanels.tenantId, tenant.id))
    .orderBy(asc(dashboardPanels.position), asc(dashboardPanels.createdAt));

  const withData = await Promise.all(panels.map(async (panel) => {
    const config = (panel.config ?? {}) as Record<string, unknown>;
    const datasetKey = typeof config.datasetKey === 'string' ? config.datasetKey : null;
    let rows: Array<{ row: unknown; capturedAt: Date }> = [];
    if (datasetKey && panel.type !== 'markdown') {
      const limit = panel.type === 'kpi' ? 1 : Math.min(Number(config.limit) || 50, 200);
      rows = await db
        .select({ row: datasets.row, capturedAt: datasets.capturedAt })
        .from(datasets)
        .where(and(eq(datasets.tenantId, tenant.id), eq(datasets.key, datasetKey)))
        .orderBy(desc(datasets.capturedAt))
        .limit(limit);
    }
    return {
      id: panel.id,
      type: panel.type,
      title: panel.title,
      config,
      rows: rows.reverse(), // oldest → newest for charts
    };
  }));

  return NextResponse.json({ panels: withData });
}
