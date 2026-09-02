/**
 * The browser-free PDF renderer — pdf-lib, pure JS, no Chromium, no native
 * dependency, no network.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The primary renderer prints HTML in AWS AgentCore's managed Chrome. That is
 * the better-looking path and it should stay the default — but whether AWS
 * permits `Page.printToPDF` on a browser we do not own is not our decision, the
 * session can be busy, and a client proposal must not depend on any of it.
 * This file is the answer to "what happens when the browser says no": a
 * complete document, plainer, always.
 *
 * pdf-lib and not pdfkit: pdfkit reads its font metrics off disk with `fs`,
 * which Next.js server bundles handle badly, and its layout is stateful in ways
 * that fight a paginator. pdf-lib is data-in/bytes-out with the standard 14
 * fonts embedded, so nothing has to be traced into the deployment image.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE GOTCHA THAT WILL BITE
 *
 * The standard fonts are WinAnsi (cp1252) encoded. `drawText` THROWS on any
 * character outside it — and an agent writes '→' and '✅' without thinking,
 * because it writes markdown for a chat window all day. An exception thrown
 * three pages into a render, from a document that read perfectly in review, is
 * exactly the failure this whole file exists to prevent, so every string is
 * routed through `winAnsi()` before it reaches the page.
 */

import type { PDFFont, PDFPage, RGB } from 'pdf-lib';
import type { DocBlock } from '@/libs/docs/markdown';
import type { DocumentSpec } from '@/libs/docs/pdf';
import { Buffer } from 'node:buffer';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { inlinePlain } from '@/libs/docs/markdown';

const PAGE = {
  letter: {
    width: 612,
    height: 792,
  },
  a4: {
    width: 595.28,
    height: 841.89,
  },
};

const MARGIN = {
  top: 58,
  bottom: 62,
  left: 56,
  right: 56,
};

/** Characters cp1252 has above 0xFF. Everything else above it is dropped. */
const CP1252_HIGH = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split(''));

/**
 * Common symbols an agent reaches for that WinAnsi cannot encode. Transliterate
 * rather than delete: a checklist that loses every '✓' is a checklist that
 * reads as though nothing was done.
 */
const TRANSLITERATE: Array<[RegExp, string]> = [
  [/[\u2192\u27A1\u21D2]/g, '->'],
  [/[\u2190\u21D0]/g, '<-'],
  [/[\u2713\u2714\u2705]/g, '[x]'],
  [/[\u2717\u2718\u274C]/g, '[ ]'],
  [/\u26A0/g, '!'],
  [/[\u25CF\u25AA\u25E6]/g, '\u2022'],
  [/[\u00A0\u2007\u2009\u202F]/g, ' '],
  /** The variation selector that follows an emoji has no glyph of its own. */
  [/\uFE0F/g, ''],
];

export function winAnsi(text: string): string {
  let out = String(text ?? '');
  for (const [pattern, replacement] of TRANSLITERATE) {
    out = out.replace(pattern, replacement);
  }
  return out
    .split('')
    .filter(ch => ch.charCodeAt(0) < 256 || CP1252_HIGH.has(ch))
    .join('')
    // A tab is encodable but pdf-lib refuses to draw it; spaces are what a
    // reader sees anyway.
    .replace(/\t/g, '    ');
}

function color(hex: string | undefined, fallback: string): RGB {
  const raw = String(hex ?? '').trim().replace(/^#/, '');
  const value = /^[0-9a-f]{6}$/i.test(raw)
    ? raw
    : /^[0-9a-f]{3}$/i.test(raw) ? raw.split('').map(c => c + c).join('') : fallback;
  return rgb(
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  );
}

/** Greedy word wrap. A single unbreakable token is hard-split rather than run off the page. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = winAnsi(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';

  const widthOf = (value: string): number => {
    try {
      return font.widthOfTextAtSize(value, size);
    } catch {
      return value.length * size * 0.5;
    }
  };

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (widthOf(candidate) <= maxWidth || !line) {
      if (widthOf(candidate) > maxWidth && !line) {
        // One word wider than the column (a long URL): break it by character.
        let chunk = '';
        for (const ch of word) {
          if (widthOf(chunk + ch) > maxWidth && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
        continue;
      }
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) {
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

type Ctx = {
  doc: PDFDocument;
  page: PDFPage;
  pages: PDFPage[];
  y: number;
  width: number;
  height: number;
  contentWidth: number;
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  mono: PDFFont;
  accent: RGB;
  text: RGB;
  muted: RGB;
  rule: RGB;
  zebra: RGB;
};

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([ctx.width, ctx.height]);
  ctx.pages.push(ctx.page);
  ctx.y = ctx.height - MARGIN.top;
}

/** Start a new page when `needed` points will not fit above the bottom margin. */
function ensure(ctx: Ctx, needed: number): void {
  if (ctx.y - needed < MARGIN.bottom) {
    newPage(ctx);
  }
}

function drawLines(
  ctx: Ctx,
  lines: string[],
  a: { font: PDFFont; size: number; leading: number; color: RGB; x?: number },
): void {
  for (const line of lines) {
    ensure(ctx, a.leading);
    ctx.page.drawText(line, {
      x: a.x ?? MARGIN.left,
      y: ctx.y - a.size,
      size: a.size,
      font: a.font,
      color: a.color,
    });
    ctx.y -= a.leading;
  }
}

async function fetchImageBytes(url: string): Promise<{ bytes: Uint8Array; png: boolean } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      return null;
    }
    const type = (resp.headers.get('content-type') ?? '').toLowerCase();
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > 8 * 1024 * 1024) {
      return null;
    }
    // pdf-lib embeds PNG and JPEG only. Sniff the magic bytes rather than
    // trusting a content-type header a CDN guessed at.
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const isJpg = buf[0] === 0xFF && buf[1] === 0xD8;
    if (!isPng && !isJpg) {
      return null;
    }
    return {
      bytes: buf,
      png: isPng || type.includes('png'),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function drawImage(ctx: Ctx, url: string, alt: string): Promise<void> {
  const fetched = await fetchImageBytes(url);
  if (!fetched) {
    // Visible degradation, exactly as pptx.ts does it: a silent gap looks like
    // the renderer lost the image, and nobody can act on that.
    drawLines(ctx, wrap(`[image could not be loaded: ${alt || url}]`, ctx.italic, 9, ctx.contentWidth), {
      font: ctx.italic,
      size: 9,
      leading: 13,
      color: ctx.muted,
    });
    ctx.y -= 6;
    return;
  }
  try {
    const image = fetched.png
      ? await ctx.doc.embedPng(fetched.bytes)
      : await ctx.doc.embedJpg(fetched.bytes);
    const scale = Math.min(1, ctx.contentWidth / image.width);
    const width = image.width * scale;
    const height = image.height * scale;
    ensure(ctx, height + 10);
    // An image taller than a whole page is scaled to the page, not clipped.
    const maxHeight = ctx.height - MARGIN.top - MARGIN.bottom;
    const finalScale = height > maxHeight ? maxHeight / height : 1;
    ctx.page.drawImage(image, {
      x: MARGIN.left,
      y: ctx.y - height * finalScale,
      width: width * finalScale,
      height: height * finalScale,
    });
    ctx.y -= height * finalScale + 14;
  } catch {
    drawLines(ctx, [`[image could not be embedded: ${winAnsi(alt || url).slice(0, 90)}]`], {
      font: ctx.italic,
      size: 9,
      leading: 13,
      color: ctx.muted,
    });
  }
}

/**
 * Tables get proportional columns derived from their own content, capped so one
 * long cell cannot squeeze every other column into a vertical alphabet. The
 * header row repeats after a page break — a five-page table whose headings
 * appeared once is unreadable.
 */
function drawTable(ctx: Ctx, headers: string[], rows: string[][]): void {
  const columnCount = Math.max(headers.length, ...rows.map(r => r.length), 1);
  const size = 8.5;
  const padding = 5;
  const cells = [headers, ...rows];

  const natural: number[] = Array.from({ length: columnCount }, (_, i) => {
    const widest = cells.reduce((max, row) => {
      const value = winAnsi(inlinePlain(row[i] ?? ''));
      let width = 0;
      try {
        width = ctx.regular.widthOfTextAtSize(value, size);
      } catch {
        width = value.length * size * 0.5;
      }
      return Math.max(max, width);
    }, 0);
    return Math.min(Math.max(widest + padding * 2, 42), ctx.contentWidth * 0.55);
  });

  const total = natural.reduce((sum, w) => sum + w, 0);
  const widths = natural.map(w => (w / total) * ctx.contentWidth);

  const drawRow = (row: string[], opts: { header: boolean; index: number }): void => {
    const font = opts.header ? ctx.bold : ctx.regular;
    const wrapped = widths.map((w, i) => wrap(inlinePlain(row[i] ?? ''), font, size, w - padding * 2));
    const lineCount = Math.max(...wrapped.map(l => l.length), 1);
    const rowHeight = lineCount * (size + 3) + padding * 2;

    if (ctx.y - rowHeight < MARGIN.bottom) {
      newPage(ctx);
      if (!opts.header && headers.length > 0) {
        drawRow(headers, {
          header: true,
          index: -1,
        });
      }
    }

    const top = ctx.y;
    if (opts.header) {
      ctx.page.drawRectangle({
        x: MARGIN.left,
        y: top - rowHeight,
        width: ctx.contentWidth,
        height: rowHeight,
        color: ctx.accent,
      });
    } else if (opts.index % 2 === 1) {
      ctx.page.drawRectangle({
        x: MARGIN.left,
        y: top - rowHeight,
        width: ctx.contentWidth,
        height: rowHeight,
        color: ctx.zebra,
      });
    }

    let x = MARGIN.left;
    wrapped.forEach((lines, i) => {
      lines.forEach((line, li) => {
        ctx.page.drawText(line, {
          x: x + padding,
          y: top - padding - size - li * (size + 3),
          size,
          font,
          color: opts.header ? rgb(1, 1, 1) : ctx.text,
        });
      });
      x += widths[i] ?? 0;
    });

    ctx.page.drawLine({
      start: {
        x: MARGIN.left,
        y: top - rowHeight,
      },
      end: {
        x: MARGIN.left + ctx.contentWidth,
        y: top - rowHeight,
      },
      thickness: 0.5,
      color: ctx.rule,
    });
    ctx.y -= rowHeight;
  };

  if (headers.length > 0) {
    drawRow(headers, {
      header: true,
      index: -1,
    });
  }
  rows.forEach((row, index) => drawRow(row, {
    header: false,
    index,
  }));
  ctx.y -= 14;
}

async function drawBlock(ctx: Ctx, block: DocBlock): Promise<void> {
  switch (block.type) {
    case 'heading': {
      const size = block.level === 1 ? 15 : block.level === 2 ? 12.5 : 11;
      ctx.y -= block.level === 1 ? 14 : 10;
      // Keep a heading with its first line of body text.
      ensure(ctx, size * 2 + 22);
      drawLines(ctx, wrap(inlinePlain(block.text), ctx.bold, size, ctx.contentWidth), {
        font: ctx.bold,
        size,
        leading: size + 5,
        color: block.level === 2 ? ctx.accent : ctx.text,
      });
      ctx.y -= 4;
      break;
    }
    case 'paragraph':
      drawLines(ctx, wrap(inlinePlain(block.text), ctx.regular, 10, ctx.contentWidth), {
        font: ctx.regular,
        size: 10,
        leading: 15,
        color: ctx.text,
      });
      ctx.y -= 6;
      break;
    case 'list': {
      block.items.forEach((item, index) => {
        const marker = block.ordered ? `${index + 1}.` : '•';
        const indent = 16;
        const lines = wrap(inlinePlain(item), ctx.regular, 10, ctx.contentWidth - indent);
        ensure(ctx, 15);
        ctx.page.drawText(winAnsi(marker), {
          x: MARGIN.left,
          y: ctx.y - 10,
          size: 10,
          font: ctx.regular,
          color: ctx.accent,
        });
        drawLines(ctx, lines, {
          font: ctx.regular,
          size: 10,
          leading: 15,
          color: ctx.text,
          x: MARGIN.left + indent,
        });
      });
      ctx.y -= 6;
      break;
    }
    case 'table':
      drawTable(ctx, block.headers, block.rows);
      break;
    case 'quote': {
      const lines = wrap(inlinePlain(block.text), ctx.italic, 10, ctx.contentWidth - 16);
      ensure(ctx, lines.length * 15 + 6);
      const top = ctx.y;
      drawLines(ctx, lines, {
        font: ctx.italic,
        size: 10,
        leading: 15,
        color: ctx.muted,
        x: MARGIN.left + 14,
      });
      ctx.page.drawRectangle({
        x: MARGIN.left,
        y: ctx.y,
        width: 2.5,
        height: Math.max(top - ctx.y, 12),
        color: ctx.accent,
      });
      ctx.y -= 8;
      break;
    }
    case 'code': {
      const lines = block.text.split('\n').flatMap(line => wrap(line, ctx.mono, 8.5, ctx.contentWidth - 16));
      ensure(ctx, Math.min(lines.length, 6) * 12 + 12);
      drawLines(ctx, lines, {
        font: ctx.mono,
        size: 8.5,
        leading: 12,
        color: ctx.text,
        x: MARGIN.left + 8,
      });
      ctx.y -= 8;
      break;
    }
    case 'image':
      await drawImage(ctx, block.url, block.alt);
      break;
    case 'divider':
      ensure(ctx, 18);
      ctx.y -= 8;
      ctx.page.drawLine({
        start: {
          x: MARGIN.left,
          y: ctx.y,
        },
        end: {
          x: MARGIN.left + ctx.contentWidth,
          y: ctx.y,
        },
        thickness: 0.7,
        color: ctx.rule,
      });
      ctx.y -= 14;
      break;
    case 'pagebreak':
      newPage(ctx);
      break;
    default:
      break;
  }
}

export type FallbackResult = { pdf: Buffer; bytes: number; pageCount: number };

export async function renderFallbackPdf(spec: DocumentSpec, blocks: DocBlock[]): Promise<FallbackResult> {
  const doc = await PDFDocument.create();
  const size = PAGE[spec.pageSize === 'a4' ? 'a4' : 'letter'];
  const width = spec.landscape ? size.height : size.width;
  const height = spec.landscape ? size.width : size.height;

  const ctx: Ctx = {
    doc,
    page: doc.addPage([width, height]),
    pages: [],
    y: height - MARGIN.top,
    width,
    height,
    contentWidth: width - MARGIN.left - MARGIN.right,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
    accent: color(spec.theme?.accent, '0F62FE'),
    text: color(spec.theme?.text, '111827'),
    muted: color(spec.theme?.muted, '6B7280'),
    rule: color(undefined, 'E5E7EB'),
    zebra: color(undefined, 'F9FAFB'),
  };
  ctx.pages.push(ctx.page);

  doc.setTitle(winAnsi(spec.title).slice(0, 200));
  doc.setProducer('Artivio');

  // Title block — same shape as the styled renderer's, so the two versions of a
  // document are recognisably the same document.
  drawLines(ctx, wrap(inlinePlain(spec.title), ctx.bold, 20, ctx.contentWidth), {
    font: ctx.bold,
    size: 20,
    leading: 25,
    color: ctx.text,
  });
  if (spec.subtitle) {
    ctx.y -= 2;
    drawLines(ctx, wrap(inlinePlain(spec.subtitle), ctx.regular, 11, ctx.contentWidth), {
      font: ctx.regular,
      size: 11,
      leading: 15,
      color: ctx.muted,
    });
  }
  ctx.y -= 26;
  ctx.page.drawRectangle({
    x: MARGIN.left,
    y: ctx.y,
    width: 54,
    height: 2.5,
    color: ctx.accent,
  });
  ctx.y -= 22;

  for (const block of blocks) {
    await drawBlock(ctx, block);
  }

  // Footers last: the page total is only known once everything is laid out.
  const total = ctx.pages.length;
  const label = winAnsi(String(spec.footer ?? '')).slice(0, 120);
  ctx.pages.forEach((page, index) => {
    const numbering = `${index + 1} / ${total}`;
    if (label) {
      page.drawText(label, {
        x: MARGIN.left,
        y: MARGIN.bottom - 26,
        size: 7.5,
        font: ctx.regular,
        color: ctx.muted,
      });
    }
    const numberWidth = ctx.regular.widthOfTextAtSize(numbering, 7.5);
    page.drawText(numbering, {
      x: width - MARGIN.right - numberWidth,
      y: MARGIN.bottom - 26,
      size: 7.5,
      font: ctx.regular,
      color: ctx.muted,
    });
  });

  const bytes = await doc.save();
  const buffer = Buffer.from(bytes);
  return {
    pdf: buffer,
    bytes: buffer.length,
    pageCount: total,
  };
}
