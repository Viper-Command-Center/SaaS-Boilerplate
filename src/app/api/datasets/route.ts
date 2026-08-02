/**
 * PATCH /api/datasets?tenant=<slug> — edit fields of one dataset row.
 * Body: { id: <dataset row uuid>, patch: { field: value, ... } }
 *
 * Phase 26: the human control that pairs with the agent's write_dataset
 * mechanism (the Phase 21/24 rule). Table panels render a status dropdown
 * that calls this, so changing a task from pending → done no longer requires
 * asking the agent. Deliberately shallow: merges scalar fields into the row's
 * JSON, never replaces the row, never touches other rows.
 *
 * Editor+ only, tenant-scoped by row id. Not approval-gated for the same
 * reason panel layout isn't: it touches nothing outside this workspace's own
 * dataset rows.
 */

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { datasets } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const EDITOR_ROLES = ['owner', 'admin', 'editor'];

const PatchSchema = z.object({
  id: z.string().uuid(),
  // Scalars only — a nested object here would smuggle structure the table
  // renderer can't display and the agent doesn't expect.
  patch: z.record(
    z.string().min(1).max(80),
    z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]),
  ).refine(p => Object.keys(p).length >= 1 && Object.keys(p).length <= 20, {
    message: 'Provide 1-20 fields.',
  }),
});

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Role check BEFORE reading the body (the upload-403 lesson).
  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  const tenant = (await getUserTenants(user.id)).find(t => t.slug === slug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }
  if (!user.isAdmin && !EDITOR_ROLES.includes(tenant.role)) {
    return NextResponse.json({ error: 'You need editor access to edit rows.' }, { status: 403 });
  }

  let body: z.infer<typeof PatchSchema>;
  try {
    body = PatchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid edit request.' }, { status: 400 });
  }

  // Tenant-scope the row — the client sends an id, so re-scope rather than
  // trusting it.
  const [existing] = await db
    .select({ id: datasets.id, row: datasets.row })
    .from(datasets)
    .where(and(eq(datasets.tenantId, tenant.id), eq(datasets.id, body.id)))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ error: 'Row not found.' }, { status: 404 });
  }

  const current = (existing.row ?? {}) as Record<string, unknown>;
  const merged = { ...current, ...body.patch };

  await db
    .update(datasets)
    .set({ row: merged })
    .where(and(eq(datasets.tenantId, tenant.id), eq(datasets.id, body.id)));

  return NextResponse.json({ ok: true, row: merged });
}
