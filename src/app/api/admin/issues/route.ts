/**
 * GET   /api/admin/issues        — the operator's escalation inbox
 * PATCH /api/admin/issues        — { id, status: 'open' | 'resolved' }
 *
 * Platform-class issues land here automatically (and by email) the moment they
 * happen, with the real error and a diagnostic bundle — so a bug is actionable
 * without the client having to describe the symptom.
 */

import { desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { buildBundle } from '@/libs/support/issues';
import { issues, tenants } from '@/models/Schema';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  const status = new URL(request.url).searchParams.get('status') ?? 'open';

  const rows = await db
    .select({
      id: issues.id,
      kind: issues.kind,
      source: issues.source,
      message: issues.message,
      detail: issues.detail,
      status: issues.status,
      reportedByAgent: issues.reportedByAgent,
      createdAt: issues.createdAt,
      workspace: tenants.slug,
    })
    .from(issues)
    .leftJoin(tenants, eq(issues.tenantId, tenants.id))
    .where(status === 'all' ? undefined : eq(issues.status, status))
    .orderBy(desc(issues.createdAt))
    .limit(100);

  return NextResponse.json({
    issues: rows.map(r => ({
      ...r,
      // Ready to paste straight to an engineer — no interviewing the client.
      bundle: buildBundle({
        source: r.source,
        workspace: r.workspace ?? 'unknown',
        message: r.message,
        detail: r.detail,
      }),
    })),
  });
}

const PatchSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['open', 'resolved']),
});

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  let body: z.infer<typeof PatchSchema>;
  try {
    body = PatchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  await db.update(issues).set({ status: body.status }).where(eq(issues.id, body.id));
  return NextResponse.json({ ok: true });
}
