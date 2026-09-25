/**
 * Poll a Duda migration job's status (Phase 48, Part 1).
 *
 * GET /api/migration/duda/status?tenant=<slug>&job=<jobId>
 *   → { job: { status, currentPhase, error, … }, items: [...] }
 *
 * Read-only, any workspace member (same rule as the other dashboard GETs). This
 * is the stopgap way to watch progress until the dashboard UI lands in a later
 * part.
 */

import { NextResponse } from 'next/server';
import { getJob, listItems } from '@/libs/migration/store';
import { guard, isResponse } from '@/libs/wpsites/access';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('tenant') ?? '';
  const jobId = url.searchParams.get('job') ?? '';

  const g = await guard(slug, 'read');
  if (isResponse(g)) {
    return g;
  }
  if (!jobId) {
    return NextResponse.json({ error: 'job is required.' }, { status: 400 });
  }

  const job = await getJob(g.tenant.id, jobId);
  if (!job) {
    return NextResponse.json({ error: 'No such migration job in this workspace.' }, { status: 404 });
  }
  const items = await listItems(job.id);
  const counts = items.reduce<Record<string, number>>((acc, it) => {
    const key = `${it.itemType}:${it.status}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({ job, counts, items });
}
