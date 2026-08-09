/**
 * GET /api/panels?tenant=<slug> — dashboard views (tabs) + their panels with
 * data resolved server-side (dataset rows for kpi/timeseries/table panels).
 *
 * Table panels support filter/sort in config (Phase 26):
 *   filter: { field: value, ... }  — row matches when EVERY entry matches
 *                                    (string-compared, so 1 == "1")
 *   sortBy: 'field', sortDir: 'asc'|'desc' — numeric-aware ordering
 * Filtering happens BEFORE limit, or a filtered panel would only ever see
 * whatever happened to be newest — which is exactly the bug that made six
 * "week" panels all display the same September rows.
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

/**
 * Rows scanned when a table panel filters/sorts. Bounded so a huge dataset
 * can't make the dashboard poll expensive; if a workspace outgrows this, the
 * agent should split datasets (e.g. per week) rather than filter one giant one.
 */
const FILTER_SCAN_LIMIT = 1000;

type StoredRow = { id: string; row: unknown; capturedAt: Date };

function rowMatches(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [field, want] of Object.entries(filter)) {
    if (String(row[field] ?? '') !== String(want ?? '')) {
      return false;
    }
  }
  return true;
}

/** Numeric-aware comparison: "9" < "10", but "W2" still sorts after "W1". */
function compareValues(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    return na - nb;
  }
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true });
}

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

    const filter = config.filter && typeof config.filter === 'object' && !Array.isArray(config.filter)
      ? config.filter as Record<string, unknown>
      : null;
    const sortBy = typeof config.sortBy === 'string' ? config.sortBy : null;
    const shaped = panel.type === 'table' && (filter || sortBy);

    let rows: StoredRow[] = [];
    if (datasetKey && panel.type !== 'markdown') {
      const limit = panel.type === 'kpi' ? 1 : Math.min(Number(config.limit) || 50, 200);
      rows = await db
        .select({ id: datasets.id, row: datasets.row, capturedAt: datasets.capturedAt })
        .from(datasets)
        .where(and(eq(datasets.tenantId, tenant.id), eq(datasets.key, datasetKey)))
        .orderBy(desc(datasets.capturedAt))
        // Filters must see the whole (bounded) dataset, not the newest slice.
        .limit(shaped ? FILTER_SCAN_LIMIT : limit);

      if (shaped) {
        if (filter) {
          rows = rows.filter(r => rowMatches((r.row ?? {}) as Record<string, unknown>, filter));
        }
        if (sortBy) {
          const dir = config.sortDir === 'desc' ? -1 : 1;
          rows = rows.slice().sort((x, y) =>
            dir * compareValues(
              ((x.row ?? {}) as Record<string, unknown>)[sortBy],
              ((y.row ?? {}) as Record<string, unknown>)[sortBy],
            ),
          );
        }
        rows = rows.slice(0, limit);
      }
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
      // sortBy panels are already in display order; everything else stays
      // oldest → newest for charts (the client reverses tables itself).
      rows: sortBy && panel.type === 'table' ? rows : rows.reverse(),
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
