/**
 * Direct-to-R2 uploads.
 *
 * POST /api/files/upload?tenant=<slug>          → { key, uploadUrl }
 *   The browser then PUTs the file straight to Cloudflare with that URL.
 * PUT  /api/files/upload?tenant=<slug>          → index the finished object
 *   { key, name, mime } — we HEAD the object to prove it landed and get the
 *   real size, so a cancelled upload never leaves a phantom row.
 *
 * The bytes never pass through the app server, so a 2GB HeyGen render is no
 * heavier on Railway than a 2KB text file. The key is minted server-side inside
 * the caller's tenant prefix — a client can't sign their way into another
 * workspace's storage.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { confirmUpload, reserveUpload } from '@/libs/storage/files';
import { storageConfigured } from '@/libs/storage/r2';
import { getUserTenants } from '@/libs/tenants';

export const dynamic = 'force-dynamic';

const WRITE_ROLES = ['owner', 'admin', 'editor'];

/** R2 accepts up to 5GB in a single PUT; beyond that needs multipart. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

async function requireWrite(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  const tenant = (await getUserTenants(user.id)).find(t => t.slug === slug);
  if (!tenant) {
    return { error: NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 }) };
  }
  if (!user.isAdmin && !WRITE_ROLES.includes(tenant.role)) {
    return {
      error: NextResponse.json(
        { error: `Uploading needs editor access — your role here is "${tenant.role}".` },
        { status: 403 },
      ),
    };
  }
  return { user, tenant };
}

const StartSchema = z.object({
  name: z.string().min(1).max(300),
  sizeBytes: z.number().min(0).max(MAX_UPLOAD_BYTES),
});

export async function POST(request: Request) {
  const ctx = await requireWrite(request);
  if (ctx.error) {
    return ctx.error;
  }
  if (!storageConfigured()) {
    return NextResponse.json(
      { error: 'File storage is not configured. Add the R2_* variables in Railway.' },
      { status: 500 },
    );
  }

  let body: z.infer<typeof StartSchema>;
  try {
    body = StartSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: `Files must be ${MAX_UPLOAD_BYTES / (1024 ** 3)}GB or smaller.` },
      { status: 413 },
    );
  }

  try {
    const { key, uploadUrl } = reserveUpload(ctx.tenant.id, body.name);
    return NextResponse.json({ key, uploadUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not start the upload.';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

const ConfirmSchema = z.object({
  key: z.string().min(1).max(500),
  name: z.string().min(1).max(300),
  mime: z.string().max(120).optional(),
});

export async function PUT(request: Request) {
  const ctx = await requireWrite(request);
  if (ctx.error) {
    return ctx.error;
  }

  let body: z.infer<typeof ConfirmSchema>;
  try {
    body = ConfirmSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  try {
    const row = await confirmUpload({
      tenantId: ctx.tenant.id,
      key: body.key,
      name: body.name,
      mime: body.mime,
      createdBy: ctx.user.id,
    });
    return NextResponse.json({ ok: true, file: { id: row?.id, name: row?.name } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not save the file.';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
