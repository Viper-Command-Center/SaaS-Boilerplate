/**
 * PATCH  /api/datasets?tenant=<slug> — edit fields of one dataset row.
 *        Body: { id: <dataset row uuid>, patch: { field: value, ... } }
 * POST   /api/datasets?tenant=<slug> — append ONE row to a dataset.
 *        Body: { key: <dataset key>, row: { field: value, ... } }
 * DELETE /api/datasets?tenant=<slug>&id=<row uuid> — remove one row.
 *
 * Phase 26 added PATCH: the human control pairing with the agent's
 * write_dataset mechanism (the Phase 21/24 rule). It closed half the gap.
 *
 * 🔴 PHASE 33 — the other half. A user could edit a row but not CREATE or
 * REMOVE one, so "add a link to my notes" still meant asking the agent — and
 * the agent, having no add-row tool to offer, invented a workaround: ten blank
 * rows for the user to fill in. That is the Phase 24 complaint repeating almost
 * word for word ("I cant do anything"), and it is worth naming why. Phase 26
 * wired ONE verb and stopped. A panel a user can edit but cannot add to is not
 * an editable panel; it is a read-only panel with one exception, and it reads
 * to the user as broken.
 *
 * Deliberately shallow throughout: scalar fields only, one row per call, never
 * a bulk replace. Editor+ only, and every handler re-scopes by tenant rather
 * than trusting the id the client sent.
 *
 * Not approval-gated, for the same reason panel layout isn't: it touches
 * nothing outside this workspace's own dataset rows.
 */

import { and, eq, sql } from 'drizzle-orm';
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

/** Same shape as a PATCH body's `patch`: scalars only, 1–20 fields. */
const RowFields = z.record(
  z.string().min(1).max(80),
  z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]),
).refine(r => Object.keys(r).length >= 1 && Object.keys(r).length <= 20, {
  message: 'Provide 1-20 fields.',
});

const CreateSchema = z.object({
  key: z.string().min(1).max(120),
  row: RowFields,
});

/** Guard against a stuck client turning one table into unbounded storage. */
const MAX_ROWS_PER_DATASET = 5_000;

export async function POST(request: Request) {
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
    return NextResponse.json({ error: 'You need editor access to add rows.' }, { status: 403 });
  }

  let body: z.infer<typeof CreateSchema>;
  try {
    body = CreateSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid row.' }, { status: 400 });
  }

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(datasets)
    .where(and(eq(datasets.tenantId, tenant.id), eq(datasets.key, body.key)));
  if (count >= MAX_ROWS_PER_DATASET) {
    return NextResponse.json(
      { error: `This dataset already holds ${MAX_ROWS_PER_DATASET} rows. Remove some before adding more.` },
      { status: 409 },
    );
  }

  // Return the created row WITH its id: the caller needs it to edit or delete
  // what it just added, and without it the new row is unaddressable until the
  // next poll.
  const [created] = await db
    .insert(datasets)
    .values({ tenantId: tenant.id, key: body.key, row: body.row })
    .returning({ id: datasets.id, row: datasets.row, capturedAt: datasets.capturedAt });

  return NextResponse.json({ ok: true, ...created });
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = new URL(request.url);
  const slug = url.searchParams.get('tenant') ?? '';
  const tenant = (await getUserTenants(user.id)).find(t => t.slug === slug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }
  if (!user.isAdmin && !EDITOR_ROLES.includes(tenant.role)) {
    return NextResponse.json({ error: 'You need editor access to remove rows.' }, { status: 403 });
  }

  const id = url.searchParams.get('id') ?? '';
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'A row id is required.' }, { status: 400 });
  }

  // ONE row, always scoped to this tenant. There is deliberately no bulk or
  // by-key delete here: a UI button that can empty a whole dataset in one
  // request is a footgun no dashboard needs.
  const deleted = await db
    .delete(datasets)
    .where(and(eq(datasets.tenantId, tenant.id), eq(datasets.id, id)))
    .returning({ id: datasets.id });

  if (deleted.length === 0) {
    return NextResponse.json({ error: 'Row not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id });
}
