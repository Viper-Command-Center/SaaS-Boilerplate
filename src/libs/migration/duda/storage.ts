/**
 * Job-scoped file storage for the migration Markdown set + media (Phase 48,
 * Part 1).
 *
 * Everything a job produces lives under the tenant's R2 prefix, mirroring the
 * file library's convention (keys are always `tenants/<tenantId>/…`, derived
 * server-side, never from client input — see src/libs/storage/r2.ts):
 *
 *   tenants/<tenantId>/migration/<jobId>/
 *     00-overview.md
 *     pages/<slug>.md
 *     posts/<date>-<slug>.md
 *     design/current-design.md
 *     design/new-design-brief.md
 *     collections/<name>.json
 *     media/<hash>.<ext>
 *     media/manifest.json
 *
 * We reuse the raw R2 object helpers rather than the `files` table indexer:
 * these are job artefacts (a reviewable folder), not library files, and Part 3
 * / the dashboard will read them back by key.
 */

import { createHash } from 'node:crypto';
import { getObject, putObject } from '@/libs/storage/r2';

export function jobPrefix(tenantId: string, jobId: string): string {
  return `tenants/${tenantId}/migration/${jobId}`;
}

/** Write a UTF-8 text file (Markdown / JSON) into the job folder. */
export async function writeText(
  tenantId: string,
  jobId: string,
  relPath: string,
  content: string,
  contentType = 'text/markdown; charset=utf-8',
): Promise<string> {
  const key = `${jobPrefix(tenantId, jobId)}/${relPath}`;
  await putObject(key, Buffer.from(content, 'utf8'), contentType);
  return relPath;
}

/** Read a text file back (used by tests / later phases). */
export async function readText(tenantId: string, jobId: string, relPath: string): Promise<string> {
  const { body } = await getObject(`${jobPrefix(tenantId, jobId)}/${relPath}`);
  return body.toString('utf8');
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

/** A stable, content-addressed media filename (dedup by hash). */
export function mediaFilename(bytes: Buffer, contentType: string, sourceUrl: string): string {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  let ext = EXT_BY_MIME[contentType.split(';')[0]!.trim().toLowerCase()];
  if (!ext) {
    const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(sourceUrl);
    ext = (m?.[1] ?? 'bin').toLowerCase();
  }
  return `${hash}.${ext}`;
}

/** Store one image and return its job-relative path. */
export async function writeMedia(
  tenantId: string,
  jobId: string,
  filename: string,
  bytes: Buffer,
  contentType: string,
): Promise<string> {
  const rel = `media/${filename}`;
  await putObject(`${jobPrefix(tenantId, jobId)}/${rel}`, bytes, contentType || 'application/octet-stream');
  return rel;
}
