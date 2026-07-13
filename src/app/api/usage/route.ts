/**
 * GET /api/usage?tenant=<slug> — this workspace's own spend view (what the
 * client sees): billed month-to-date vs their plan allowance, today's usage
 * against the daily cap, and recent activity.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/libs/auth/session';
import { checkSpend } from '@/libs/billing/meter';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { usageEvents } from '@/models/Schema';

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

  const status = await checkSpend(tenant.id);

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const bySource = await db
    .select({
      kind: usageEvents.kind,
      source: usageEvents.source,
      billed: sql<string>`coalesce(sum(${usageEvents.billedUsd}), 0)`,
      calls: sql<string>`count(*)`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.tenantId, tenant.id), gte(usageEvents.at, monthStart)))
    .groupBy(usageEvents.kind, usageEvents.source)
    .orderBy(desc(sql`sum(${usageEvents.billedUsd})`))
    .limit(10);

  return NextResponse.json({
    paused: status.paused,
    allowed: status.allowed,
    reason: status.reason,
    todayCostUsd: status.todayCostUsd,
    dailyCapUsd: status.dailyCapUsd,
    monthBilledUsd: status.monthBilledUsd,
    monthlyBudgetUsd: status.monthlyBudgetUsd,
    breakdown: bySource.map(r => ({
      kind: r.kind,
      source: r.source,
      billedUsd: Number(r.billed),
      calls: Number(r.calls),
    })),
  });
}
