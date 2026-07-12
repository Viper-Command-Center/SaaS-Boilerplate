/**
 * GET /api/approvals?tenant=<slug> — pending (and recent decided) approvals.
 */

import { desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { approvals } from '@/models/Schema';

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

  const rows = await db
    .select()
    .from(approvals)
    .where(eq(approvals.tenantId, tenant.id))
    .orderBy(desc(approvals.requestedAt))
    .limit(50);

  return NextResponse.json({ approvals: rows });
}
