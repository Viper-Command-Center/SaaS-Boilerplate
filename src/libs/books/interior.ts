/**
 * Interior PDF renderer — KDP-compliant page boxes, margins and gutters.
 *
 * pdf-lib only (pure JS, no browser, cannot fail for environmental reasons —
 * same reasoning as pdfFallback.ts). Every art page is resampled by sharp to
 * the EXACT pixel size of the box it fills at 300 dpi before embedding, so
 * the PDF carries no more pixels than the press uses, and a 60-page book
 * stays well under KDP's 650 MB ceiling.
 *
 * Geometry comes from kdp.ts — the same functions preflight uses — so what
 * the checker approves is what gets drawn.
 */

import type { InkType, PaperType, TrimSize } from './kdp';
import { PDFDocument, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { embedBookFonts, fitFontSize, wrapText } from './fonts';
import { interiorPageIn, interiorSafeBoxIn, inToPt, inToPx } from './kdp';
import { prepareLineArt } from './lineArt';

export type InteriorPage
  = | { kind: 'art'; bytes: Buffer; label?: string }
    | { kind: 'blank' }
    | { kind: 'text'; heading?: string; lines?: string[]; label?: string };

export type InteriorSpec = {
  trim: TrimSize;
  bleed: boolean;
  paper: PaperType;
  ink: InkType;
  /** Physical pages in order — blanks already inserted (see expandPages). */
  pages: InteriorPage[];
  /** Coloring pages: threshold to pure black/white at render. Off keeps tones. */
  lineArt: boolean;
  title: string;
};

export type InteriorResult = {
  pdf: Buffer;
  pageCount: number;
  bytes: number;
  fontsEmbedded: boolean;
};

/**
 * Turn the user's ordered page list into PHYSICAL pages. `singleSided` puts
 * a blank behind every art page so markers never bleed through onto the
 * next drawing; `padToEven` guarantees an even count (KDP would add its own
 * blank otherwise).
 */
export function expandPages(pages: InteriorPage[], a: { singleSided: boolean; padToEven?: boolean }): InteriorPage[] {
  const out: InteriorPage[] = [];
  for (const p of pages) {
    out.push(p);
    if (a.singleSided && p.kind === 'art') {
      out.push({ kind: 'blank' });
    }
  }
  if ((a.padToEven ?? true) && out.length % 2 === 1) {
    out.push({ kind: 'blank' });
  }
  return out;
}

export async function renderInterior(spec: InteriorSpec): Promise<InteriorResult> {
  const doc = await PDFDocument.create();
  doc.setTitle(spec.title);
  doc.setProducer('Artivio');
  doc.setCreator('Artivio Book Publisher');
  const fonts = await embedBookFonts(doc);

  const pageIn = interiorPageIn(spec.trim, spec.bleed);
  const pageW = inToPt(pageIn.widthIn);
  const pageH = inToPt(pageIn.heightIn);
  const count = spec.pages.length;

  for (let i = 0; i < count; i++) {
    const p = spec.pages[i]!;
    const n = i + 1;
    const page = doc.addPage([pageW, pageH]);
    // Explicit white so a viewer with a dark theme still shows the page white,
    // and so nothing is "transparent" (KDP wants flattened files).
    page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(1, 1, 1) });

    if (p.kind === 'blank') {
      continue;
    }

    const safe = interiorSafeBoxIn({ trim: spec.trim, bleed: spec.bleed, pageCount: count, pageNumber: n });

    if (p.kind === 'text') {
      const x = inToPt(safe.xIn);
      const w = inToPt(safe.widthIn);
      const top = inToPt(safe.yIn + safe.heightIn);
      let y = top - inToPt(0.6);
      if (p.heading) {
        const size = fitFontSize(fonts.displayBold, p.heading, { maxWidth: w, maxLines: 3, max: 40, min: 18 });
        for (const line of wrapText(fonts.displayBold, p.heading, size, w)) {
          const lw = fonts.displayBold.widthOfTextAtSize(line, size);
          page.drawText(line, { x: x + (w - lw) / 2, y: y - size, size, font: fonts.displayBold, color: rgb(0, 0, 0) });
          y -= size * 1.25;
        }
        y -= inToPt(0.3);
      }
      const bodySize = 12;
      for (const raw of p.lines ?? []) {
        if (!raw.trim()) {
          y -= bodySize;
          continue;
        }
        for (const line of wrapText(fonts.body, raw, bodySize, w)) {
          const lw = fonts.body.widthOfTextAtSize(line, bodySize);
          page.drawText(line, { x: x + (w - lw) / 2, y: y - bodySize, size: bodySize, font: fonts.body, color: rgb(0, 0, 0) });
          y -= bodySize * 1.5;
        }
      }
      continue;
    }

    // ── art ──
    // With bleed the image FILLS the page box (cropped to fit); without it the
    // image sits INSIDE the safe box (letterboxed on white). Either way it is
    // resampled to the exact pixel size first.
    const target = spec.bleed ? { xIn: 0, yIn: 0, widthIn: pageIn.widthIn, heightIn: pageIn.heightIn } : safe;
    const px = { width: inToPx(target.widthIn), height: inToPx(target.heightIn) };
    const prepared = await prepareLineArt(p.bytes, {
      targetPx: px,
      fit: spec.bleed ? 'cover' : 'contain',
      keepTones: !spec.lineArt,
      // when keeping tones we only resample; no threshold/despeckle
      despeckle: spec.lineArt ? 1 : 0,
    });
    // Pure black/white pages are tiny as palette PNGs; toned/colour pages are
    // far smaller as JPEG (a 2550² RGB PNG is ~8 MB; the same JPEG ~600 KB),
    // and at 300 dpi the difference is invisible on paper.
    const img = spec.lineArt
      ? await doc.embedPng(prepared.png)
      : await doc.embedJpg(await sharp(prepared.png).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer());
    page.drawImage(img, {
      x: inToPt(target.xIn),
      y: inToPt(target.yIn),
      width: inToPt(target.widthIn),
      height: inToPt(target.heightIn),
    });
  }

  const bytes = Buffer.from(await doc.save({ useObjectStreams: true }));
  return { pdf: bytes, pageCount: count, bytes: bytes.length, fontsEmbedded: fonts.embedded };
}
