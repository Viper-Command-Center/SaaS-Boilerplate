/**
 * POST /api/files/download?tenant=<slug>  { ids: string[] }
 *
 * Streams the selected library files as ONE zip. The Files page used to offer
 * only Open (a new tab) — pulling 30 coloring pages an agent just made meant
 * open → right-click → save, thirty times (Ryan, 2026-09-08). Any member of
 * the workspace can download; the membership check is the same as
 * /api/files/[id]/content. Files are added as promises and streamed, so a
 * 30-file / 100 MB set never sits in memory at once. Images and PDFs are
 * already compressed — STORE, not DEFLATE, so the zip is fast.
 */

import JSZip from 'jszip';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { getFile } from '@/libs/storage/files';
import { getObject } from '@/libs/storage/r2';
import { MAX_ZIP_BYTES, MAX_ZIP_FILES, uniqueName } from '@/libs/storage/zip';
import { getUserTenants } from '@/libs/tenants';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const Body = z.object({ ids: z.array(z.string().uuid()).min(1).max(MAX_ZIP_FILES) });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  const tenant = (await getUserTenants(user.id)).find(t => t.slug === slug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: `Pass ids: up to ${MAX_ZIP_FILES} file ids.` }, { status: 400 });
  }

  const rows = (await Promise.all([...new Set(parsed.data.ids)].map(id => getFile(tenant.id, id)))).filter((r): r is NonNullable<typeof r> => Boolean(r));
  if (rows.length === 0) {
    return NextResponse.json({ error: 'None of those files exist in this workspace.' }, { status: 404 });
  }
  const total = rows.reduce((n, r) => n + r.sizeBytes, 0);
  if (total > MAX_ZIP_BYTES) {
    return NextResponse.json({ error: `Selection is ${Math.round(total / 1024 / 1024)} MB; one zip is capped at ${MAX_ZIP_BYTES / 1024 / 1024} MB. Select fewer files.` }, { status: 413 });
  }

  const zip = new JSZip();
  const taken = new Set<string>();
  for (const row of rows) {
    // A promise per entry: JSZip pulls each one as it streams that entry.
    zip.file(uniqueName(row.name, taken), getObject(row.r2Key).then(o => o.body), { compression: 'STORE', date: row.createdAt });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${slug}-files-${stamp}.zip`;
  const nodeStream = zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'STORE' });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', err => controller.error(err));
    },
    cancel() {
      nodeStream.pause();
    },
  });
  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-File-Count': String(rows.length),
    },
  });
}
