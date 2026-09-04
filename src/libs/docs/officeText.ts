/**
 * Office document text — .docx / .pptx / .xlsx → plain text.
 *
 * Why this exists: until 2026-09-04 the library extracted text for plain-text
 * formats and PDFs only. A .docx — the single most common thing a client
 * uploads — was stored with `textContent: null`, and `read_file` answered "no
 * extractable text". The agent then INVENTED a reason ("complex formatting,
 * older Word XML…") because the note gave it nothing true to say. Same shape
 * of failure as the PDF one in pdfText.ts, same fix: read it, cache it once.
 *
 * All three formats are OOXML — a ZIP of XML parts — so this is pure JS with
 * no browser, no native dep and no model call:
 *   - .docx → mammoth (handles tables, lists, footnotes, headers properly)
 *   - .pptx → jszip: every ppt/slides/slideN.xml, `<a:t>` runs joined per
 *             paragraph, in slide order (the ZIP order is NOT slide order)
 *   - .xlsx → jszip: sharedStrings + each worksheet as tab-separated rows
 *
 * Both libraries are imported dynamically so the server bundle for every route
 * that happens to reach files.ts does not carry them.
 *
 * Contract matches PdfExtraction: `text` is null when nothing readable came
 * out — never '' pretending to be an empty document — and `note` is a
 * plain-English reason safe to hand to the agent verbatim.
 */

import type { Buffer } from 'node:buffer';

export type OfficeKind = 'docx' | 'pptx' | 'xlsx';

export type OfficeExtraction = {
  text: string | null;
  kind: OfficeKind;
  note?: string;
};

const MIME: Record<OfficeKind, RegExp> = {
  docx: /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/i,
  pptx: /^application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation$/i,
  xlsx: /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/i,
};

/**
 * Which Office format this is, or null. Extension wins over MIME — browsers
 *  and S3 clients routinely send `application/octet-stream` for .docx.
 */
export function officeKind(name: string, mime?: string | null): OfficeKind | null {
  const n = String(name ?? '');
  if (/\.docx$/i.test(n)) {
    return 'docx';
  }
  if (/\.pptx$/i.test(n)) {
    return 'pptx';
  }
  if (/\.xlsx$/i.test(n)) {
    return 'xlsx';
  }
  const m = String(mime ?? '');
  for (const k of Object.keys(MIME) as OfficeKind[]) {
    if (MIME[k].test(m)) {
      return k;
    }
  }
  return null;
}

export function isOfficeDoc(name: string, mime?: string | null): boolean {
  return officeKind(name, mime) !== null;
}

/**
 * Legacy binary formats we deliberately do NOT parse (.doc/.xls/.ppt are
 *  OLE compound files, not ZIP+XML). The note tells the agent what to ask for.
 */
export function isLegacyOffice(name: string): boolean {
  return /\.(?:doc|xls|ppt|rtf)$/i.test(String(name ?? ''));
}

/** Decode the XML entities OOXML text runs actually contain. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** Collapse whitespace the way a reader would, keep paragraph breaks. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\xA0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * mammoth → HTML → text, not `extractRawText`: raw text puts every table cell
 * on its own line, so a budget table reads as a column of unrelated words.
 * Going through HTML keeps rows on one line (cells tab-separated), list items
 * as lines, and headings as their own paragraph.
 */
async function docxText(bytes: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.convertToHtml({ buffer: bytes });
  const html = result.value ?? '';
  const text = html
    // Flatten each cell first: its inner paragraphs join with a space, so a
    // multi-paragraph cell cannot break the row it belongs to.
    .replace(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi, (_m, _t, inner: string) =>
      `${inner.replace(/<\/p>\s*<p\b[^>]*>/gi, ' ').replace(/<\/?p\b[^>]*>/gi, '')}\t`)
    .replace(/<\/tr>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|h[1-6]|li|table)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/\t\n/g, '\n');
  return tidy(unescapeXml(text));
}

async function pptxText(bytes: Buffer): Promise<string> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  const out: string[] = [];
  for (const [i, f] of slideFiles.entries()) {
    const xml = await zip.file(f)?.async('string');
    if (!xml) {
      continue;
    }
    const paragraphs: string[] = [];
    for (const p of xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []) {
      const runs = [...p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(m => unescapeXml(m[1] ?? ''));
      const line = runs.join('').trim();
      if (line) {
        paragraphs.push(line);
      }
    }
    // Speaker notes live in a separate part; slide text is what people ask for.
    out.push(`--- Slide ${i + 1} ---\n${paragraphs.join('\n')}`);
  }
  return tidy(out.join('\n\n'));
}

async function xlsxText(bytes: Buffer): Promise<string> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);

  // Shared strings: most text cells point here by index.
  const shared: string[] = [];
  const ssXml = await zip.file('xl/sharedStrings.xml')?.async('string');
  if (ssXml) {
    for (const si of ssXml.match(/<si\b[\s\S]*?<\/si>/g) ?? []) {
      // A rich-text cell has several <t> runs; join them.
      const runs = [...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1] ?? ''));
      shared.push(runs.join(''));
    }
  }

  // Sheet names, in workbook order, mapped to their part via the rels file.
  const wb = (await zip.file('xl/workbook.xml')?.async('string')) ?? '';
  const rels = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) ?? '';
  // Attribute ORDER is not fixed in OOXML — Excel writes Id before Target,
  // openpyxl the reverse — so pull each attribute out of the tag separately.
  const attr = (tag: string, name: string): string =>
    new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
  const relTarget = new Map<string, string>();
  for (const r of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
    relTarget.set(attr(r, 'Id'), attr(r, 'Target').replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const sheets = (wb.match(/<sheet\b[^>]*>/g) ?? []).map(tag => ({
    name: unescapeXml(attr(tag, 'name')),
    path: `xl/${relTarget.get(attr(tag, 'r:id')) ?? ''}`,
  }));

  const out: string[] = [];
  for (const s of sheets) {
    const xml = await zip.file(s.path)?.async('string');
    if (!xml) {
      continue;
    }
    const rows: string[] = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
      // Cells are SPARSE — an empty A3 is simply absent — so place each value
      // by its column letter or every later column shifts left. `<c …/>` is a
      // styled-but-empty cell; without the self-closing branch it would
      // swallow everything up to the NEXT cell's close tag.
      const cells: string[] = [];
      for (const c of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] ?? '';
        const inner = c[2] ?? '';
        const col = (/\br="([A-Z]+)\d*"/.exec(attrs)?.[1] ?? '')
          .split('')
          .reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
        if (col > cells.length) {
          cells.push(...Array.from<string>({ length: col - cells.length }).fill(''));
        }
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        let v = '';
        if (type === 's') {
          const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]);
          v = shared[idx] ?? '';
        } else if (type === 'inlineStr') {
          v = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1] ?? '')).join('');
        } else {
          v = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
        }
        cells.push(v.replace(/\t/g, ' '));
      }
      const line = cells.join('\t').replace(/\t+$/, '');
      if (line.trim()) {
        rows.push(line);
      }
    }
    out.push(`--- Sheet: ${s.name} ---\n${rows.join('\n')}`);
  }
  return tidy(out.join('\n\n'));
}

/**
 * Never throws for a document that merely fails to parse — a corrupt or
 * password-protected file is still a file worth keeping in the library.
 */
export async function extractOfficeText(a: { bytes: Buffer; name: string; mime?: string | null }): Promise<OfficeExtraction> {
  const kind = officeKind(a.name, a.mime);
  if (!kind) {
    throw new Error(`Not an Office document: ${a.name}`);
  }
  try {
    const text = kind === 'docx'
      ? await docxText(a.bytes)
      : kind === 'pptx'
        ? await pptxText(a.bytes)
        : await xlsxText(a.bytes);
    if (!text) {
      return {
        text: null,
        kind,
        note: `This .${kind} opened but contains no text (it may be images only, or an empty document).`,
      };
    }
    return { text, kind };
  } catch (err) {
    const why = err instanceof Error ? err.message.slice(0, 140) : 'unknown error';
    return {
      text: null,
      kind,
      note: `This .${kind} could not be parsed (${why}). It may be password-protected, corrupt, or not actually a .${kind}. Ask the client to re-export it, or for a PDF.`,
    };
  }
}
