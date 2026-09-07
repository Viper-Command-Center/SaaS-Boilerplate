/**
 * Full-wrap cover renderer — back + spine + front in one KDP-sized PDF.
 *
 * ONE raster renderer (@napi-rs/canvas at 300 dpi) produces both the print
 * file and the preview PNG, so what the user approves on screen is
 * pixel-for-pixel what KDP prints. Text is rasterised at 300 dpi — that is
 * how most POD covers are delivered, it sidesteps font embedding entirely,
 * and a 7-pt minimum still comes out 29 px tall. The PDF is just that
 * raster placed on a page of the exact geometry from kdp.ts.
 *
 * Why not draw text with pdf-lib: it would give vector text but no preview
 * (pdf-lib cannot rasterise), and the agent — and the author — need to SEE
 * the cover before it goes anywhere. Two renderers would drift.
 */

import type { SKRSContext2D } from '@napi-rs/canvas';
import type { Box, CoverGeometry, InkType, PaperType, TrimSize } from './kdp';
import path from 'node:path';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { BLEED_IN, coverGeometry, DPI, inToPt, inToPx, SPINE_SAFE_IN } from './kdp';

export type CoverSpec = {
  trim: TrimSize;
  pageCount: number;
  paper: PaperType;
  ink: InkType;
  title: string;
  subtitle?: string;
  author?: string;
  /** Back-cover copy. Wrapped and sized to fit above the barcode zone. */
  blurb?: string;
  /** Put title + author on the spine (only honoured when KDP allows it). */
  spineText?: boolean;
  frontArt?: Buffer | null;
  backArt?: Buffer | null;
  /** Hex colours. */
  background?: string;
  spineColor?: string;
  textColor?: string;
  /** Translucent band behind the front-cover text for legibility over art. */
  titleBand?: boolean;
  titlePosition?: 'top' | 'bottom';
  /** Small line printed on the back, e.g. "artivio.ai" or an ISBN-free note. */
  backFooter?: string;
  /**
   * The supplied front art is a FINISHED cover (title, author, tagline already
   * typeset in the image). Draw nothing on the front — no title, no band, no
   * author. Mia's workspace, 2026-09-07: the renderer doubled the title over a
   * Canva cover and every workaround (titleBand:false, matching text colour,
   * empty strings) still left ghost text, because the front text block was
   * unconditional.
   */
  frontArtIsFinal?: boolean;
};

export type CoverResult = {
  pdf: Buffer;
  previewPng: Buffer;
  fullPng: Buffer;
  geometry: CoverGeometry;
  widthPx: number;
  heightPx: number;
  /** what was actually drawn — the agent reports this back to the user */
  notes: string[];
};

let fontsReady = false;
function ensureFonts(): boolean {
  if (fontsReady) {
    return true;
  }
  const dir = path.join(process.cwd(), 'public', 'fonts');
  const ok = [
    GlobalFonts.registerFromPath(path.join(dir, 'Fredoka-Bold.ttf'), 'Fredoka'),
    GlobalFonts.registerFromPath(path.join(dir, 'Fredoka-SemiBold.ttf'), 'Fredoka'),
    GlobalFonts.registerFromPath(path.join(dir, 'Nunito-Regular.ttf'), 'Nunito'),
    GlobalFonts.registerFromPath(path.join(dir, 'Nunito-Bold.ttf'), 'Nunito'),
  ].every(Boolean);
  fontsReady = ok;
  return ok;
}

/** Keep blurb text this far above the barcode block. */
const BARCODE_CLEAR_IN = 0.6;

const DISPLAY = 'Fredoka';
const BODY = 'Nunito';
const FALLBACK = 'sans-serif';

export async function renderCover(spec: CoverSpec): Promise<CoverResult> {
  const notes: string[] = [];
  const haveFonts = ensureFonts();
  if (!haveFonts) {
    notes.push('Bundled fonts were not found; the system sans-serif was used.');
  }
  const display = haveFonts ? DISPLAY : FALLBACK;
  const body = haveFonts ? BODY : FALLBACK;

  const g = coverGeometry({ trim: spec.trim, pageCount: spec.pageCount, paper: spec.paper, ink: spec.ink });
  const W = inToPx(g.widthIn);
  const H = inToPx(g.heightIn);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const px = (v: number) => v * DPI;
  // kdp.ts boxes are PDF-space (origin bottom-left); canvas is top-down.
  const topOf = (box: Box) => H - px(box.yIn + box.heightIn);
  const bg = hex(spec.background, '#ffffff');
  const text = hex(spec.textColor, '#111111');
  const spineColor = hex(spec.spineColor, bg);

  // ── background (covers bleed too) ──
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // ── art: front fills front box + bleed on top/bottom/right; back mirrors ──
  const frontFull: Box = { xIn: g.front.xIn, yIn: 0, widthIn: g.front.widthIn + BLEED_IN, heightIn: g.heightIn };
  const backFull: Box = { xIn: 0, yIn: 0, widthIn: g.back.widthIn + BLEED_IN, heightIn: g.heightIn };
  if (spec.frontArt) {
    await drawCoverArt(ctx, spec.frontArt, frontFull);
  } else {
    notes.push('No front art was supplied — the front is a flat colour with the title.');
  }
  if (spec.backArt) {
    await drawCoverArt(ctx, spec.backArt, backFull);
  }

  // ── spine ──
  ctx.fillStyle = spineColor;
  ctx.fillRect(px(g.spine.xIn), 0, px(g.spine.widthIn), H);
  const spineOk = Boolean(spec.spineText) && g.spineTextAllowed;
  if (spec.spineText && !g.spineTextAllowed) {
    notes.push(`Spine text skipped: KDP requires at least 79 pages (this book has ${spec.pageCount}).`);
  }
  if (spineOk) {
    const label = clean([spec.title, spec.author].filter(Boolean).join('   ·   '));
    const usableH = px(g.spine.heightIn - 2 * 0.25); // keep clear of top/bottom trim
    const usableW = px(g.spine.widthIn - 2 * SPINE_SAFE_IN);
    // Text runs top→bottom (rotated 90° clockwise) — the convention for US books.
    // One line, so size is bounded by the spine width via cap height (~0.72 em
    // for Fredoka) and by the spine length via measured width. KDP's floor is 7 pt.
    const minPt = px(7 / 72);
    let size = Math.floor(usableW / 0.72);
    ctx.font = `bold ${size}px ${display}`;
    while (size > minPt && ctx.measureText(label).width > usableH) {
      size -= 1;
      ctx.font = `bold ${size}px ${display}`;
    }
    if (size >= minPt) {
      ctx.save();
      ctx.translate(px(g.spine.xIn + g.spine.widthIn / 2), px(g.spine.yIn + g.spine.heightIn / 2));
      ctx.rotate(Math.PI / 2);
      ctx.font = `bold ${size}px ${display}`;
      ctx.fillStyle = text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 0);
      ctx.restore();
    } else {
      notes.push('Spine text skipped: the spine is too thin for legible 7-pt text.');
    }
  }

  // ── front text ──
  const fs = g.frontSafe;
  if (spec.frontArtIsFinal && spec.frontArt) {
    notes.push('Front text skipped (frontArtIsFinal): the front art is used as the finished cover — no title, subtitle or author was drawn over it.');
  }
  const title = clean(spec.title);
  const subtitle = clean(spec.subtitle ?? '');
  const author = clean(spec.author ?? '');
  const colW = px(fs.widthIn) * 0.9;
  const titleSize = fitSize(ctx, title, `bold {s}px ${display}`, { maxWidth: colW, maxLines: 3, max: px(fs.heightIn) * 0.14, min: px(0.2) });
  const titleLines = wrap(ctx, title, `bold ${titleSize}px ${display}`, colW);
  const subSize = subtitle ? fitSize(ctx, subtitle, `{s}px ${display}`, { maxWidth: colW, maxLines: 2, max: titleSize * 0.5, min: px(0.14) }) : 0;
  const subLines = subtitle ? wrap(ctx, subtitle, `${subSize}px ${display}`, colW) : [];
  const authorSize = author ? Math.max(px(0.16), titleSize * 0.35) : 0;

  const lineGap = 1.15;
  const blockH = titleLines.length * titleSize * lineGap + (subLines.length ? subLines.length * subSize * lineGap + titleSize * 0.3 : 0);
  const cx = px(fs.xIn + fs.widthIn / 2);
  const fsTop = topOf(fs);
  const fsBottom = fsTop + px(fs.heightIn);
  const topY = fsTop + px(0.35);
  const bottomY = fsBottom - blockH - (author ? authorSize * 2.2 : px(0.35));
  const blockTop = (spec.titlePosition ?? 'top') === 'bottom' ? bottomY : topY;
  const drawFrontText = !(spec.frontArtIsFinal && spec.frontArt);

  if (drawFrontText && (spec.titleBand ?? Boolean(spec.frontArt))) {
    ctx.fillStyle = withAlpha(bg, 0.82);
    roundRect(ctx, cx - colW / 2 - px(0.2), blockTop - px(0.15), colW + px(0.4), blockH + px(0.3), px(0.15));
    ctx.fill();
  }

  ctx.fillStyle = text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let y = blockTop;
  ctx.font = `bold ${titleSize}px ${display}`;
  for (const line of drawFrontText ? titleLines : []) {
    ctx.fillText(line, cx, y);
    y += titleSize * lineGap;
  }
  if (drawFrontText && subLines.length) {
    y += titleSize * 0.3;
    ctx.font = `${subSize}px ${display}`;
    for (const line of subLines) {
      ctx.fillText(line, cx, y);
      y += subSize * lineGap;
    }
  }
  if (drawFrontText && author) {
    ctx.font = `bold ${authorSize}px ${body}`;
    ctx.textBaseline = 'bottom';
    const ay = fsBottom - px(0.35);
    if (spec.titleBand ?? Boolean(spec.frontArt)) {
      const aw = ctx.measureText(author).width;
      ctx.fillStyle = withAlpha(bg, 0.82);
      roundRect(ctx, cx - aw / 2 - px(0.15), ay - authorSize * 1.3, aw + px(0.3), authorSize * 1.6, px(0.1));
      ctx.fill();
      ctx.fillStyle = text;
    }
    ctx.fillText(author, cx, ay);
  }

  // ── back: blurb above the barcode zone ──
  const bs = g.backSafe;
  const blurb = clean(spec.blurb ?? '');
  if (blurb) {
    const bw = px(bs.widthIn) * 0.86;
    const availH = px(bs.heightIn - g.barcode.heightIn - BARCODE_CLEAR_IN) - px(0.5);
    const bSize = fitSize(ctx, blurb, `{s}px ${body}`, { maxWidth: bw, maxHeight: availH, max: px(0.3), min: px(0.13) });
    const lines = wrap(ctx, blurb, `${bSize}px ${body}`, bw);
    ctx.font = `${bSize}px ${body}`;
    ctx.fillStyle = text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let by = topOf(bs) + px(0.5);
    const bx = px(bs.xIn + bs.widthIn / 2);
    if (spec.backArt) {
      ctx.fillStyle = withAlpha(bg, 0.85);
      roundRect(ctx, bx - bw / 2 - px(0.2), by - px(0.2), bw + px(0.4), lines.length * bSize * 1.4 + px(0.4), px(0.15));
      ctx.fill();
      ctx.fillStyle = text;
    }
    for (const line of lines) {
      ctx.fillText(line, bx, by);
      by += bSize * 1.4;
    }
  }
  if (spec.backFooter) {
    ctx.font = `${px(0.13)}px ${body}`;
    ctx.fillStyle = text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(clean(spec.backFooter), px(bs.xIn + 0.2), topOf(bs) + px(bs.heightIn) - px(0.3));
  }

  // ── barcode zone: KDP prints the ISBN barcode here; it must be blank white ──
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(px(g.barcode.xIn), topOf(g.barcode), px(g.barcode.widthIn), px(g.barcode.heightIn));

  // ── outputs ──
  const fullPng = canvas.toBuffer('image/png');
  const jpeg = await sharp(fullPng).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  const previewPng = await sharp(fullPng).resize({ width: 1600, withoutEnlargement: true }).png().toBuffer();

  const doc = await PDFDocument.create();
  doc.setTitle(`${spec.title} — cover`);
  doc.setProducer('Artivio');
  doc.setCreator('Artivio Book Publisher');
  const page = doc.addPage([inToPt(g.widthIn), inToPt(g.heightIn)]);
  const img = await doc.embedJpg(jpeg);
  page.drawImage(img, { x: 0, y: 0, width: inToPt(g.widthIn), height: inToPt(g.heightIn) });
  const pdf = Buffer.from(await doc.save({ useObjectStreams: true }));

  return { pdf, previewPng, fullPng, geometry: g, widthPx: W, heightPx: H, notes };
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function drawCoverArt(ctx: SKRSContext2D, bytes: Buffer, box: Box) {
  const w = inToPx(box.widthIn);
  const h = inToPx(box.heightIn);
  // sharp does the cover-fit crop (centre) and colour normalisation; canvas
  // then blits a correctly sized RGB image. Keeps the canvas path simple.
  const fitted = await sharp(bytes, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' }).resize({ width: w, height: h, fit: 'cover', position: 'centre', kernel: 'lanczos3' }).png().toBuffer();
  const img = await loadImage(fitted);
  ctx.drawImage(img, inToPx(box.xIn), inToPx(box.yIn), w, h);
}

function wrap(ctx: SKRSContext2D, text: string, font: string, maxWidth: number): string[] {
  ctx.font = font;
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxWidth || !line) {
        line = next;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) {
      out.push(line);
    }
  }
  return out;
}

/** Largest font size whose wrapped text fits the constraints. `{s}` is the size slot. */
function fitSize(ctx: SKRSContext2D, text: string, fontTpl: string, c: { maxWidth: number; maxLines?: number; maxHeight?: number; max: number; min: number }): number {
  let size = Math.floor(c.max);
  const step = Math.max(1, Math.floor((c.max - c.min) / 40));
  while (size >= c.min) {
    const lines = wrap(ctx, text, fontTpl.replace('{s}', String(size)), c.maxWidth);
    const okLines = c.maxLines === undefined || lines.length <= c.maxLines;
    const okHeight = c.maxHeight === undefined || lines.length * size * 1.4 <= c.maxHeight;
    if (okLines && okHeight) {
      return size;
    }
    size -= step;
  }
  return Math.floor(c.min);
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hex(v: string | undefined, fallback: string): string {
  const s = (v ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s : /^#[0-9a-f]{3}$/i.test(s) ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : fallback;
}

function withAlpha(h: string, a: number): string {
  const r = Number.parseInt(h.slice(1, 3), 16);
  const g = Number.parseInt(h.slice(3, 5), 16);
  const b = Number.parseInt(h.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** Drop emoji/symbols the bundled fonts cannot draw (they render as boxes). */
function clean(s: string): string {
  return s.replace(/\p{Extended_Pictographic}|\uFE0F/gu, '').replace(/[ \t]+/g, ' ').trim();
}
