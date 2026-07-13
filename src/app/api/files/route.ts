/**
 * Workspace file library.
 *
 * GET    /api/files?tenant=<slug>   — list (any member)
 * POST   /api/files                 — multipart upload (editor+)
 * DELETE /api/files?id=&tenant=     — remove from R2 + index (editor+)
 *
 * The R2 key is always derived from the SESSION's tenant, never from client
 * input, so a workspace can only ever touch its own prefix.
 */

import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/libs/auth/session';
import { listFiles, removeFile, saveFile } from '@/libs/storage/files';
import { storageConfigured } from '@/libs/storage/r2';
import { getUserTenants } from '@/libs/tenants';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const WRITE_ROLES = ['owner', 'admin', 'editor'];
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB

async function resolveTenant(userId: string, isAdmin: boolean, slug: string, needWrite: boolean) {
  const tenant = (await getUserTenants(userId)).find(t => t.slug === slug);
  if (!tenant) {
    return null;
  }
  if (needWrite && !isAdmin && !WRITE_ROLES.includes(tenant.role)) {
    return null;
  }
  return tenant;
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  const tenant = await resolveTenant(user.id, user.isAdmin, slug, false);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }

  const rows = await listFiles(tenant.id);
  return NextResponse.json({
    storageConfigured: storageConfigured(),
    files: rows.map(f => ({ ...f, hasText: Boolean(f.hasText) })),
  });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!storageConfigured()) {
    return NextResponse.json(
      { error: 'File storage is not configured. Add the R2_* variables in Railway.' },
      { status: 500 },
    );
  }

  const form = await request.formData().catch(() => null);
  const slug = String(form?.get('tenant') ?? '');
  const file = form?.get('file');

  const tenant = await resolveTenant(user.id, user.isAdmin, slug, true);
  if (!tenant) {
    return NextResponse.json({ error: 'You need editor access to upload files.' }, { status: 403 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'Files must be 25MB or smaller.' }, { status: 413 });
  }

  try {
    const row = await saveFile({
      tenantId: tenant.id,
      name: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
      mime: file.type,
      kind: 'knowledge',
      source: 'upload',
      createdBy: user.id,
    });
    return NextResponse.json({ ok: true, file: { id: row?.id, name: row?.name } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload failed.';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const tenant = await resolveTenant(user.id, user.isAdmin, params.get('tenant') ?? '', true);
  if (!tenant) {
    return NextResponse.json({ error: 'You need editor access to delete files.' }, { status: 403 });
  }
  const ok = await removeFile(tenant.id, params.get('id') ?? '');
  return NextResponse.json({ ok });
}
