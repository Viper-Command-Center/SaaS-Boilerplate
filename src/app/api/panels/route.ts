/**
 * GET /api/panels?tenant=<slug> — dashboard views (tabs) + their panels with
 * data resolved server-side (dataset rows for kpi/timeseries/table panels).
 *
 * PATCH /api/panels?tenant=<slug> — persist a drag: { moves: [{id, viewId,
 * section, position}] }. Editor+ only. Layout is deliberately not approval-
 * gated: it touches nothing outside this workspace's own dashboard.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { dashboardPanels, dashboardViews, datasets } from '@/models/Schema';

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

  const views = await db
    .select()
    .from(dashboardViews)
    .where(eq(dashboardViews.tenantId, tenant.id))
    .orderBy(asc(dashboardViews.position), asc(dashboardViews.createdAt));

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
      // A panel whose view was deleted is "unfiled" — it surfaces on the first
      // tab rather than disappearing. Losing a tab must not lose panels.
      viewId: panel.viewId && views.some(v => v.id === panel.viewId)
        ? panel.viewId
        : (views[0]?.id ?? null),
      section: panel.section,
      width: panel.width,
      position: panel.position,
      rows: rows.reverse(), // oldest → newest for charts
    };
  }));

  return NextResponse.json({
    views: views.map(v => ({ id: v.id, name: v.name, icon: v.icon, position: v.position })),
    panels: withData,
  });
}

const MoveSchema = z.object({
  moves: z.array(z.object({
    id: z.string().uuid(),
    viewId: z.string().uuid().nullable().optional(),
    section: z.string().max(60).nullable().optional(),
    position: z.number().int().min(0).max(9999),
  })).min(1).max(200),
});

const EDITOR_ROLES = ['owner', 'admin', 'editor'];

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Role check BEFORE reading the body, so a malformed body can never be
  // reported as a permissions problem (the upload-403 lesson).
  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  const tenant = (await getUserTenants(user.id)).find(t => t.slug === slug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }
  if (!user.isAdmin && !EDITOR_ROLES.includes(tenant.role)) {
    return NextResponse.json({ error: 'You need editor access to rearrange the dashboard.' }, { status: 403 });
  }

  let body: z.infer<typeof MoveSchema>;
  try {
    body = MoveSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid layout request.' }, { status: 400 });
  }

  // Every id must belong to THIS tenant — the client sends ids, so re-scope
  // rather than trusting them.
  const ids = body.moves.map(m => m.id);
  const owned = await db
    .select({ id: dashboardPanels.id })
    .from(dashboardPanels)
    .where(and(eq(dashboardPanels.tenantId, tenant.id), inArray(dashboardPanels.id, ids)));
  const ownedIds = new Set(owned.map(p => p.id));

  const validViews = await db
    .select({ id: dashboardViews.id })
    .from(dashboardViews)
    .where(eq(dashboardViews.tenantId, tenant.id));
  const validViewIds = new Set(validViews.map(v => v.id));

  let applied = 0;
  for (const m of body.moves) {
    if (!ownedIds.has(m.id)) {
      continue;
    }
    // A viewId from another tenant would move a panel onto a foreign tab.
    if (m.viewId && !validViewIds.has(m.viewId)) {
      continue;
    }
    await db
      .update(dashboardPanels)
      .set({
        ...(m.viewId !== undefined ? { viewId: m.viewId } : {}),
        ...(m.section !== undefined ? { section: m.section || null } : {}),
        position: m.position,
      })
      .where(and(eq(dashboardPanels.id, m.id), eq(dashboardPanels.tenantId, tenant.id)));
    applied += 1;
  }

  return NextResponse.json({ ok: true, applied });
}
