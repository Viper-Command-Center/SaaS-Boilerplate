/**
 * The workspace file library — one place for everything a workspace owns.
 *
 *  · KNOWLEDGE  the client uploads a brief, brand guide or a 5-page list of
 *    changes; the agent reads it with `read_file` instead of being pasted a
 *    wall of text. Text is extracted at upload time and stored alongside the
 *    bytes, so reading a doc costs one DB row, not a download + parse.
 *  · ASSETS     the agent generates media (Kie.ai deletes its originals after
 *    14 DAYS). We archive every generated URL to R2 immediately, so the link in
 *    a blog post or a scheduled social post never dies.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import {
  archiveRemote,
  deleteObject,
  getObject,
  headObject,
  presignPutUrl,
  publicUrlFor,
  putObject,
  storageConfigured,
} from '@/libs/storage/r2';
import { files } from '@/models/Schema';

export const MAX_TEXT_CHARS = 400_000;

/** Formats we can read as text today. Binary formats are stored, not parsed. */
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|csv))/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|html?|xml|log)$/i;

export function isTextual(name: string, mime?: string | null): boolean {
  return (mime ? TEXT_MIME.test(mime) : false) || TEXT_EXT.test(name);
}

function keyFor(tenantId: string, name: string): string {
  const safe = name.replace(/[^\w.-]+/g, '-').slice(-80);
  return `tenants/${tenantId}/${randomUUID()}-${safe}`;
}

/** Text is only worth extracting for things the agent can actually read. */
const MAX_EXTRACT_BYTES = 5 * 1024 * 1024;

/**
 * Big uploads (HeyGen renders, raw footage) go browser → R2 directly, so the
 * app never touches the bytes. Two steps:
 *   1. reserveUpload()  → a tenant-scoped key + a presigned PUT URL
 *   2. confirmUpload()  → HEAD the object (proves it landed, gives the real
 *      size) and index it. No row is written for an upload that never finished.
 */
export function reserveUpload(tenantId: string, name: string): { key: string; uploadUrl: string } {
  if (!storageConfigured()) {
    throw new Error('File storage is not configured (R2_* variables missing in Railway).');
  }
  const key = keyFor(tenantId, name);
  return { key, uploadUrl: presignPutUrl(key) };
}

export async function confirmUpload(a: {
  tenantId: string;
  key: string;
  name: string;
  mime?: string;
  createdBy?: string;
}) {
  // The key must be inside this tenant's prefix — never trust the client's.
  if (!a.key.startsWith(`tenants/${a.tenantId}/`)) {
    throw new Error('Invalid upload key.');
  }

  const head = await headObject(a.key);
  if (!head) {
    throw new Error('The upload did not complete — nothing was stored.');
  }

  const mime = a.mime || head.contentType;

  // Media uploaded here must be USABLE by the agent (handed to a social/ad
  // plugin, embedded in a post) — all of which need a public URL. Documents
  // (briefs, contracts, brand guides) stay private, as before.
  const isMedia = /^(image|video|audio)\//i.test(mime);
  const kind: 'knowledge' | 'asset' = isMedia ? 'asset' : 'knowledge';

  // Small text documents get their text extracted now, so read_file is a single
  // DB read later. Video and other binaries are indexed as-is.
  let text: string | null = null;
  if (isTextual(a.name, mime) && head.size <= MAX_EXTRACT_BYTES) {
    try {
      const { body } = await getObject(a.key);
      text = body.toString('utf8').slice(0, MAX_TEXT_CHARS);
    } catch {
      text = null;
    }
  }

  const [row] = await db
    .insert(files)
    .values({
      tenantId: a.tenantId,
      name: a.name.slice(0, 300),
      kind,
      mime: mime.slice(0, 120),
      sizeBytes: head.size,
      r2Key: a.key,
      publicUrl: kind === 'asset' ? publicUrlFor(a.key) : null,
      source: 'upload',
      textContent: text,
      meta: {},
      createdBy: a.createdBy,
    })
    .returning();
  return row;
}

export type SaveInput = {
  tenantId: string;
  name: string;
  bytes: Buffer;
  mime?: string;
  kind?: 'knowledge' | 'asset' | 'note';
  source?: string;
  meta?: Record<string, unknown>;
  createdBy?: string;
};

/** Store bytes in R2 + index them. Returns the row. */
export async function saveFile(input: SaveInput) {
  if (!storageConfigured()) {
    throw new Error('File storage is not configured (R2_* variables missing in Railway).');
  }
  const key = keyFor(input.tenantId, input.name);
  const mime = input.mime || 'application/octet-stream';
  await putObject(key, input.bytes, mime);

  const text = isTextual(input.name, mime)
    ? input.bytes.toString('utf8').slice(0, MAX_TEXT_CHARS)
    : null;

  const kind = input.kind ?? 'knowledge';

  // IMPORTANT: a custom R2 domain (s.artivio.ai) serves objects to ANYONE with
  // the URL. Generated media NEEDS that — a WordPress post or a scheduled social
  // post has to hit a public link. Client documents do NOT: briefs, contracts and
  // brand guides stay private and are served through /api/files/<id>/content,
  // which checks workspace membership on every request.
  const publicUrl = kind === 'asset' ? publicUrlFor(key) : null;

  const [row] = await db
    .insert(files)
    .values({
      tenantId: input.tenantId,
      name: input.name.slice(0, 300),
      kind,
      mime: mime.slice(0, 120),
      sizeBytes: input.bytes.length,
      r2Key: key,
      publicUrl,
      source: (input.source ?? 'upload').slice(0, 40),
      textContent: text,
      meta: input.meta ?? {},
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}

/**
 * Copy provider-generated media into the library. Called right after a plugin
 * call returns asset URLs — this is what stops Kie.ai's 14-day deletion from
 * silently breaking a published post.
 */
export async function archiveGeneratedAssets(a: {
  tenantId: string;
  urls: string[];
  source: string;
  meta?: Record<string, unknown>;
}): Promise<Array<{ id: string; name: string; url: string | null }>> {
  if (!storageConfigured() || a.urls.length === 0) {
    return [];
  }
  const saved: Array<{ id: string; name: string; url: string | null }> = [];

  for (const url of a.urls.slice(0, 10)) {
    try {
      const guessedName = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'generated')
        .replace(/[^\w.-]+/g, '-')
        .slice(-80);
      const key = keyFor(a.tenantId, guessedName);
      const { bytes, contentType } = await archiveRemote(url, key);

      const [row] = await db
        .insert(files)
        .values({
          tenantId: a.tenantId,
          name: guessedName,
          kind: 'asset',
          mime: contentType.slice(0, 120),
          sizeBytes: bytes,
          r2Key: key,
          publicUrl: publicUrlFor(key),
          source: a.source.slice(0, 40),
          meta: { ...(a.meta ?? {}), originalUrl: url },
        })
        .returning({ id: files.id, name: files.name, publicUrl: files.publicUrl });

      if (row) {
        saved.push({ id: row.id, name: row.name, url: row.publicUrl });
      }
    } catch {
      // An archive failure must not fail the generation the client paid for.
    }
  }
  return saved;
}

/** 100MB ceiling for an agent-initiated fetch — enough for media, not a DoS. */
const MAX_REMOTE_BYTES = 100 * 1024 * 1024;

/**
 * Pull a file from a public URL straight into the workspace library.
 *
 * This is the "save the actual PNG, not a link to it" capability. Without it the
 * agent could only write text notes, so anything binary it produced (a QR code,
 * a chart, a rendered image from any API) died as a URL in a markdown file.
 * Assets are public-URL'd so they can be used in posts and on sites.
 */
export async function saveRemoteFile(a: {
  tenantId: string;
  url: string;
  name: string;
  source?: string;
  createdBy?: string;
  meta?: Record<string, unknown>;
}) {
  if (!storageConfigured()) {
    throw new Error('File storage is not configured (R2_* variables missing).');
  }

  // Size-check before pulling the whole thing into memory where we can.
  const head = await fetch(a.url, { method: 'HEAD' }).catch(() => null);
  const declared = Number(head?.headers.get('content-length') ?? 0);
  if (declared > MAX_REMOTE_BYTES) {
    throw new Error(`That file is ${Math.round(declared / (1024 * 1024))}MB — the limit is 100MB.`);
  }

  const key = keyFor(a.tenantId, a.name);
  const { bytes, contentType } = await archiveRemote(a.url, key);
  if (bytes > MAX_REMOTE_BYTES) {
    await deleteObject(key).catch(() => {});
    throw new Error('That file is larger than the 100MB limit.');
  }

  const [row] = await db
    .insert(files)
    .values({
      tenantId: a.tenantId,
      name: a.name.slice(0, 300),
      kind: 'asset', // binary output → gets a public URL so it can be published
      mime: contentType.slice(0, 120),
      sizeBytes: bytes,
      r2Key: key,
      publicUrl: publicUrlFor(key),
      source: (a.source ?? 'agent').slice(0, 40),
      meta: { ...(a.meta ?? {}), sourceUrl: a.url },
      createdBy: a.createdBy,
    })
    .returning();
  return row;
}

export async function listFiles(tenantId: string, limit = 100) {
  return db
    .select({
      id: files.id,
      name: files.name,
      kind: files.kind,
      mime: files.mime,
      sizeBytes: files.sizeBytes,
      publicUrl: files.publicUrl,
      source: files.source,
      meta: files.meta,
      createdAt: files.createdAt,
      hasText: files.textContent,
    })
    .from(files)
    .where(eq(files.tenantId, tenantId))
    .orderBy(desc(files.createdAt))
    .limit(limit);
}

export async function getFile(tenantId: string, id: string) {
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.tenantId, tenantId), eq(files.id, id)))
    .limit(1);
  return row;
}

export async function removeFile(tenantId: string, id: string) {
  const row = await getFile(tenantId, id);
  if (!row) {
    return false;
  }
  await deleteObject(row.r2Key);
  await db.delete(files).where(and(eq(files.tenantId, tenantId), eq(files.id, id)));
  return true;
}
