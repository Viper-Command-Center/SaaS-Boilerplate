/**
 * Start a Duda → WordPress migration (Phase 48, Part 1 — Phase 1 extraction).
 *
 * POST /api/migration/duda/start
 *   { tenantSlug, sourceSiteId, destSiteId? }
 *
 * Creates a `migration_jobs` row and kicks off Phase 1 extraction in `after()`
 * (the Phase 29 principle — a full-site extract runs far longer than an HTTP
 * request should, so it is never tied to this socket). Responds 202 with the
 * job id; the caller polls the job/items rows for progress. Phase 1 sets the
 * job to `awaiting_review` on success or `failed` with the reason.
 *
 * No dashboard UI in this part — this raw endpoint is how a job is triggered
 * for now. Owner/admin only, same guard as the WordPress Sites routes.
 */

import { after, NextResponse } from 'next/server';
import { z } from 'zod';
import { DudaClient, resolveDudaCredential } from '@/libs/migration/duda/client';
import { runExtraction } from '@/libs/migration/duda/extract';
import { createJob } from '@/libs/migration/store';
import { fail, guard, isResponse } from '@/libs/wpsites/access';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const Body = z.object({
  tenantSlug: z.string().min(1).max(80),
  sourceSiteId: z.string().min(1).max(200),
  destSiteId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  // Managing a migration is a write — owners/admins only.
  const g = await guard(body.tenantSlug, 'manage');
  if (isResponse(g)) {
    return g;
  }

  const cred = await resolveDudaCredential(g.tenant.id);
  if (!cred) {
    return NextResponse.json({
      error: 'No Duda REST API credential is configured for this workspace. Add a `duda-api` credential (an API user:password from the Duda dashboard → API access) — this is the REST/Partner API, NOT the Duda MCP token.',
    }, { status: 400 });
  }

  let job;
  try {
    job = await createJob({ tenantId: g.tenant.id, sourceSiteId: body.sourceSiteId, destSiteId: body.destSiteId ?? null });
  } catch (err) {
    return fail(err, 500);
  }

  const client = new DudaClient(cred);
  after(() => runExtraction(job, client));

  return NextResponse.json({ jobId: job.id, status: job.status, accepted: true }, { status: 202 });
}
