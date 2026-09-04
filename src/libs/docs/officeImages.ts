/**
 * Embedded images out of .docx / .pptx / .xlsx.
 *
 * Companion to officeText.ts, which deliberately returns text only. Every
 * picture in an OOXML file is an ordinary PNG/JPEG/GIF sitting in the ZIP
 * under `word/media/`, `ppt/media/` or `xl/media/` — no decoding, no
 * rendering, no model call. What takes a little care is ORDER: the ZIP lists
 * media in whatever order Word wrote them (`image3.png` is routinely the
 * first picture on the page), so we walk the document's relationship file and
 * number images by where they are first referenced in the body. That is what
 * lets an agent act on "use the second image as the featured image".
 *
 * Skipped on purpose:
 *   - EMF / WMF: Windows vector clips Word creates for pasted shapes. No
 *     browser renders them, WordPress rejects them by default, and they
 *     carry no photo. Reported in `skipped` so the count is explainable.
 *   - Anything over MAX_IMAGE_BYTES, and everything past MAX_IMAGES — a spec
 *     with 300 screenshots must not fill R2 in one tool call.
 */

import type { Buffer } from 'node:buffer';
import { officeKind } from '@/libs/docs/officeText';

export type ExtractedImage = {
  /** 1-based position in reading order (docx), slide order (pptx) or zip order (xlsx). */
  order: number;
  /** Original part name inside the ZIP, e.g. "word/media/image3.png". */
  part: string;
  ext: string;
  mime: string;
  bytes: Buffer;
  /** pptx only: which slide first uses it. */
  slide?: number;
};

export type ImageExtraction = {
  images: ExtractedImage[];
  /** Parts we chose not to return, with the reason — never silently fewer. */
  skipped: Array<{ part: string; reason: string }>;
};

export const MAX_IMAGES = 40;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
};

const UNRENDERABLE = /^(?:emf|wmf|wdp|pict)$/i;

function extOf(part: string): string {
  return (/\.([a-z0-9]+)$/i.exec(part)?.[1] ?? '').toLowerCase();
}

/** rId → target part, resolved relative to the rels file's owner directory. */
function parseRels(xml: string, ownerDir: string): Map<string, string> {
  const attr = (tag: string, name: string): string =>
    new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
  const out = new Map<string, string>();
  for (const tag of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const target = attr(tag, 'Target');
    if (!target || attr(tag, 'TargetMode') === 'External') {
      continue;
    }
    const abs = target.startsWith('/')
      ? target.slice(1)
      : `${ownerDir}/${target}`.replace(/\/\.\//g, '/').replace(/[^/]+\/\.\.\//g, '');
    out.set(attr(tag, 'Id'), abs);
  }
  return out;
}

/** Every r:embed / r:id / r:link reference in body order. */
function referencedIds(bodyXml: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const m of bodyXml.matchAll(/\br:(?:embed|link|id)="([^"]+)"/g)) {
    const id = m[1] ?? '';
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export async function extractOfficeImages(a: { bytes: Buffer; name: string; mime?: string | null }): Promise<ImageExtraction> {
  const kind = officeKind(a.name, a.mime);
  if (!kind) {
    throw new Error(`Not an Office document: ${a.name}`);
  }
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(a.bytes);

  const mediaDir = kind === 'docx' ? 'word/media/' : kind === 'pptx' ? 'ppt/media/' : 'xl/media/';
  const allMedia = Object.keys(zip.files).filter(f => f.startsWith(mediaDir) && !zip.files[f]?.dir);

  // Reading-order list of media parts. Falls back to zip order for anything
  // present but never referenced from the body (e.g. only used in a header).
  const ordered: Array<{ part: string; slide?: number }> = [];
  const push = (part: string, slide?: number) => {
    if (allMedia.includes(part) && !ordered.some(o => o.part === part)) {
      ordered.push({ part, slide });
    }
  };

  if (kind === 'docx') {
    const body = (await zip.file('word/document.xml')?.async('string')) ?? '';
    const rels = parseRels((await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? '', 'word');
    for (const id of referencedIds(body)) {
      const part = rels.get(id);
      if (part) {
        push(part);
      }
    }
  } else if (kind === 'pptx') {
    const slides = Object.keys(zip.files)
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
      .sort((x, y) => Number(/(\d+)\.xml$/.exec(x)?.[1]) - Number(/(\d+)\.xml$/.exec(y)?.[1]));
    for (const [i, slidePart] of slides.entries()) {
      const body = (await zip.file(slidePart)?.async('string')) ?? '';
      const relsPath = `${slidePart.replace(/^ppt\/slides\//, 'ppt/slides/_rels/')}.rels`;
      const rels = parseRels((await zip.file(relsPath)?.async('string')) ?? '', 'ppt/slides');
      for (const id of referencedIds(body)) {
        const part = rels.get(id);
        if (part) {
          push(part, i + 1);
        }
      }
    }
  }
  for (const part of allMedia) {
    push(part);
  }

  const images: ExtractedImage[] = [];
  const skipped: ImageExtraction['skipped'] = [];
  for (const { part, slide } of ordered) {
    const ext = extOf(part);
    if (UNRENDERABLE.test(ext)) {
      skipped.push({ part, reason: `${ext.toUpperCase()} is a Windows vector clip that browsers and WordPress cannot display.` });
      continue;
    }
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      skipped.push({ part, reason: `Unrecognised media type .${ext}.` });
      continue;
    }
    if (images.length >= MAX_IMAGES) {
      skipped.push({ part, reason: `Over the ${MAX_IMAGES}-image limit for one extraction.` });
      continue;
    }
    const bytes = await zip.file(part)?.async('nodebuffer');
    if (!bytes || bytes.length === 0) {
      skipped.push({ part, reason: 'Empty part.' });
      continue;
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      skipped.push({ part, reason: `${Math.round(bytes.length / 1024 / 1024)}MB is over the ${MAX_IMAGE_BYTES / 1024 / 1024}MB per-image limit.` });
      continue;
    }
    images.push({ order: images.length + 1, part, ext, mime, bytes, slide });
  }

  return { images, skipped };
}
