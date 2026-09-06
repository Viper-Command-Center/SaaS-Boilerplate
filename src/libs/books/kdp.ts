/**
 * KDP paperback specification — the numbers, the math, and the preflight.
 *
 * Everything here is PURE (no I/O) so the rules are unit-testable and the
 * renderers (interior.ts, cover.ts) cannot drift from the checker: both read
 * the same functions. Numbers were taken from KDP's own help pages
 * (Paperback submission guidelines / "Create a paperback cover") — see
 * `SOURCES`. If KDP changes a number, change it HERE and nowhere else.
 *
 * Units: inches everywhere, converted to PDF points (72/in) or pixels
 * (300 dpi) only at the edge in the renderers.
 */

export const SOURCES = [
  'https://kdp.amazon.com/en_US/help/topic/GVBQ3CMEQW3W2VL6', // paperback formatting / margins / page counts
  'https://kdp.amazon.com/en_US/help/topic/G201953020', // paperback cover
];

export const DPI = 300;
export const PT_PER_IN = 72;
/** Bleed KDP trims off the top, bottom and OUTSIDE edge of an interior page. */
export const BLEED_IN = 0.125;
/** Minimum page count for spine text (KDP: "at least 79 pages"). */
export const SPINE_TEXT_MIN_PAGES = 79;
/** KDP's barcode block: bottom-right of the back cover, kept clear. */
export const BARCODE = { widthIn: 2, heightIn: 1.2, fromBottomIn: 0.25, fromRightIn: 0.25 };
/** Cover text/critical art must sit this far inside the trim line. */
export const COVER_SAFE_IN = 0.125;
/** Spine text must keep this much from each fold. */
export const SPINE_SAFE_IN = 0.0625;

export const round2 = (v: number): number => Math.round(v * 100) / 100;
export const round4 = (v: number): number => Math.round(v * 10000) / 10000;
export const inToPt = (v: number): number => round2(v * PT_PER_IN);
export const inToPx = (v: number): number => Math.round(v * DPI);
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

export type PaperType = 'white' | 'cream';
export type InkType = 'black' | 'color-standard' | 'color-premium';

export type TrimSize = { widthIn: number; heightIn: number; label: string };

/** KDP's supported paperback trim sizes (inches). Order = what the agent shows. */
export const TRIM_SIZES: TrimSize[] = [
  { widthIn: 5, heightIn: 8, label: '5 x 8 in' },
  { widthIn: 5.06, heightIn: 7.81, label: '5.06 x 7.81 in' },
  { widthIn: 5.25, heightIn: 8, label: '5.25 x 8 in' },
  { widthIn: 5.5, heightIn: 8.5, label: '5.5 x 8.5 in' },
  { widthIn: 6, heightIn: 9, label: '6 x 9 in' },
  { widthIn: 6.14, heightIn: 9.21, label: '6.14 x 9.21 in' },
  { widthIn: 6.69, heightIn: 9.61, label: '6.69 x 9.61 in' },
  { widthIn: 7, heightIn: 10, label: '7 x 10 in' },
  { widthIn: 7.44, heightIn: 9.69, label: '7.44 x 9.69 in' },
  { widthIn: 7.5, heightIn: 9.25, label: '7.5 x 9.25 in' },
  { widthIn: 8, heightIn: 10, label: '8 x 10 in' },
  { widthIn: 8.25, heightIn: 6, label: '8.25 x 6 in (landscape)' },
  { widthIn: 8.25, heightIn: 8.25, label: '8.25 x 8.25 in (square)' },
  { widthIn: 8.5, heightIn: 8.5, label: '8.5 x 8.5 in (square)' },
  { widthIn: 8.5, heightIn: 11, label: '8.5 x 11 in' },
  { widthIn: 8.27, heightIn: 11.69, label: 'A4 (8.27 x 11.69 in)' },
];

/**
 * Parse "8.5x8.5", "8.5 x 11", "6x9in", "a4" into a trim size. Non-KDP sizes
 * are accepted (KDP allows custom trims within a range) but flagged by
 * preflight as `custom-trim` so the user knows to pick "custom" in KDP.
 */
export function parseTrim(input: string | { widthIn: number; heightIn: number }): TrimSize | null {
  if (typeof input !== 'string') {
    const found = TRIM_SIZES.find(t => near(t.widthIn, input.widthIn) && near(t.heightIn, input.heightIn));
    return found ?? { widthIn: input.widthIn, heightIn: input.heightIn, label: `${input.widthIn} x ${input.heightIn} in (custom)` };
  }
  const s = input.trim().toLowerCase();
  if (s === 'a4') {
    return TRIM_SIZES.find(t => t.label.startsWith('A4')) ?? null;
  }
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(?:in|inch|inches|")?$/);
  if (!m) {
    return null;
  }
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  return parseTrim({ widthIn: w, heightIn: h });
}

export function isStandardTrim(t: TrimSize): boolean {
  return TRIM_SIZES.some(s => near(s.widthIn, t.widthIn) && near(s.heightIn, t.heightIn));
}

/** Page count limits by ink (KDP: black 24–828 on white, 24–776 cream; color 72–600). */
export function pageLimits(ink: InkType, paper: PaperType): { min: number; max: number } {
  if (ink === 'black') {
    return { min: 24, max: paper === 'cream' ? 776 : 828 };
  }
  return { min: 72, max: 600 };
}

/** Inside (gutter) margin by page count — KDP's table. */
export function gutterIn(pageCount: number): number {
  if (pageCount <= 150) {
    return 0.375;
  }
  if (pageCount <= 300) {
    return 0.5;
  }
  if (pageCount <= 500) {
    return 0.625;
  }
  if (pageCount <= 700) {
    return 0.75;
  }
  return 0.875;
}

/** Outside/top/bottom margin: 0.25" without bleed, 0.375" with bleed. */
export function outsideMarginIn(bleed: boolean): number {
  return bleed ? 0.375 : 0.25;
}

/**
 * The interior PDF page box. With bleed, KDP wants trim width + 0.125 (one
 * outside edge only — the inside edge is the spine) and trim height + 0.25.
 * Without bleed the page box IS the trim size.
 */
export function interiorPageIn(trim: TrimSize, bleed: boolean): { widthIn: number; heightIn: number } {
  return bleed
    ? { widthIn: trim.widthIn + BLEED_IN, heightIn: trim.heightIn + 2 * BLEED_IN }
    : { widthIn: trim.widthIn, heightIn: trim.heightIn };
}

/**
 * Where art may go on an interior page, in inches from the page box's
 * bottom-left. `side` is the physical side: odd page numbers (1, 3, …) are
 * right-hand pages whose gutter is on the LEFT; even pages' gutter is on the
 * RIGHT. With bleed the extra 0.125 sits on the outside edge, top and bottom.
 */
export function interiorSafeBoxIn(a: {
  trim: TrimSize;
  bleed: boolean;
  pageCount: number;
  pageNumber: number; // 1-based, physical
}): { xIn: number; yIn: number; widthIn: number; heightIn: number } {
  const page = interiorPageIn(a.trim, a.bleed);
  const g = gutterIn(a.pageCount);
  const o = outsideMarginIn(a.bleed);
  const rightHand = a.pageNumber % 2 === 1;
  const b = a.bleed ? BLEED_IN : 0;
  // bleed contributes to the OUTSIDE edge only
  const left = rightHand ? g : o + b;
  const right = rightHand ? o + b : g;
  return {
    xIn: left,
    yIn: o + b,
    widthIn: page.widthIn - left - right,
    heightIn: page.heightIn - 2 * (o + b),
  };
}

/** Per-page spine thickness. KDP's cover-calculator constants. */
export function spinePerPageIn(paper: PaperType, ink: InkType): number {
  if (ink === 'black') {
    return paper === 'cream' ? 0.0025 : 0.002252;
  }
  return ink === 'color-premium' ? 0.002347 : 0.002252;
}

export function spineWidthIn(pageCount: number, paper: PaperType, ink: InkType): number {
  return round4(pageCount * spinePerPageIn(paper, ink));
}

/**
 * Full-wrap cover geometry. Everything the cover renderer draws is derived
 * from this so the PDF, the preview PNG and the preflight agree.
 */
export type CoverGeometry = {
  pageCount: number;
  spineIn: number;
  widthIn: number; // bleed + back + spine + front + bleed
  heightIn: number; // bleed + trim height + bleed
  back: Box; // trim box of the back cover (no bleed)
  spine: Box;
  front: Box;
  backSafe: Box; // where text is allowed on the back
  frontSafe: Box;
  barcode: Box; // must be kept clear (white)
  spineTextAllowed: boolean;
};
export type Box = { xIn: number; yIn: number; widthIn: number; heightIn: number };

export function coverGeometry(a: { trim: TrimSize; pageCount: number; paper: PaperType; ink: InkType }): CoverGeometry {
  const spineIn = spineWidthIn(a.pageCount, a.paper, a.ink);
  const b = BLEED_IN;
  const w = a.trim.widthIn;
  const h = a.trim.heightIn;
  const back: Box = { xIn: b, yIn: b, widthIn: w, heightIn: h };
  const spine: Box = { xIn: b + w, yIn: b, widthIn: spineIn, heightIn: h };
  const front: Box = { xIn: b + w + spineIn, yIn: b, widthIn: w, heightIn: h };
  const s = COVER_SAFE_IN;
  const inset = (box: Box, extraLeft = 0, extraRight = 0): Box => ({
    xIn: box.xIn + s + extraLeft,
    yIn: box.yIn + s,
    widthIn: box.widthIn - 2 * s - extraLeft - extraRight,
    heightIn: box.heightIn - 2 * s,
  });
  return {
    pageCount: a.pageCount,
    spineIn,
    widthIn: round4(2 * b + 2 * w + spineIn),
    heightIn: round4(2 * b + h),
    back,
    spine,
    front,
    // keep text a little further from the spine fold than the trim edge
    backSafe: inset(back, 0, SPINE_SAFE_IN),
    frontSafe: inset(front, SPINE_SAFE_IN, 0),
    barcode: {
      xIn: back.xIn + back.widthIn - BARCODE.fromRightIn - BARCODE.widthIn,
      yIn: back.yIn + BARCODE.fromBottomIn,
      widthIn: BARCODE.widthIn,
      heightIn: BARCODE.heightIn,
    },
    spineTextAllowed: a.pageCount >= SPINE_TEXT_MIN_PAGES,
  };
}

// ─── Preflight ──────────────────────────────────────────────────────────────

export type PreflightIssue = {
  level: 'error' | 'warning';
  code: string;
  message: string;
  page?: number;
};

export type PreflightPage = {
  kind: 'art' | 'blank' | 'text';
  /** pixel size of the source image, when known */
  widthPx?: number;
  heightPx?: number;
};

export type PreflightInput = {
  trim: TrimSize;
  bleed: boolean;
  paper: PaperType;
  ink: InkType;
  pages: PreflightPage[]; // PHYSICAL pages, in order, blanks included
  hasCoverArt: boolean;
  title: string;
  spineText?: string;
};

/**
 * Check a book against KDP's rules BEFORE rendering. Errors will get the
 * upload rejected or the book printed wrong; warnings are things KDP accepts
 * but a reader would notice.
 */
export function preflight(book: PreflightInput): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const count = book.pages.length;
  const limits = pageLimits(book.ink, book.paper);

  if (!book.title.trim()) {
    issues.push({ level: 'error', code: 'no-title', message: 'The book has no title.' });
  }
  if (count < limits.min) {
    issues.push({
      level: 'error',
      code: 'too-few-pages',
      message: `KDP needs at least ${limits.min} pages for ${book.ink} ink; this book has ${count}. Add pages (or blank backs with singleSided) — KDP counts every physical page, including blanks.`,
    });
  }
  if (count > limits.max) {
    issues.push({ level: 'error', code: 'too-many-pages', message: `KDP allows at most ${limits.max} pages on ${book.paper} paper with ${book.ink} ink; this book has ${count}.` });
  }
  if (count % 2 === 1) {
    issues.push({ level: 'warning', code: 'odd-page-count', message: `${count} pages is odd; KDP adds a blank last page. Add one yourself so you control what it looks like.` });
  }
  if (!isStandardTrim(book.trim)) {
    issues.push({ level: 'warning', code: 'custom-trim', message: `${book.trim.widthIn} x ${book.trim.heightIn} in is not a standard KDP trim size — choose "Custom trim size" when uploading and expect fewer distribution options.` });
  }
  if (book.ink !== 'black' && book.paper === 'cream') {
    issues.push({ level: 'error', code: 'cream-color', message: 'Color ink is only printed on white paper.' });
  }
  if (!book.hasCoverArt) {
    issues.push({ level: 'error', code: 'no-cover', message: 'No front cover art set. Generate or upload one and pass it to build_book_cover.' });
  }
  if (book.spineText && count < SPINE_TEXT_MIN_PAGES) {
    issues.push({ level: 'warning', code: 'spine-text-too-thin', message: `Spine text needs at least ${SPINE_TEXT_MIN_PAGES} pages (this book has ${count}); it will be left off the cover.` });
  }

  // Resolution: art must reach 300 dpi across the box it fills.
  const page = interiorPageIn(book.trim, book.bleed);
  book.pages.forEach((p, i) => {
    if (p.kind !== 'art' || !p.widthPx || !p.heightPx) {
      return;
    }
    const n = i + 1;
    const target = book.bleed
      ? { w: page.widthIn, h: page.heightIn }
      : (() => {
          const box = interiorSafeBoxIn({ trim: book.trim, bleed: false, pageCount: count, pageNumber: n });
          return { w: box.widthIn, h: box.heightIn };
        })();
    // Uniform scale that fits/covers the target; effective dpi is the smaller axis.
    const scale = book.bleed
      ? Math.max(target.w / p.widthPx, target.h / p.heightPx) // cover
      : Math.min(target.w / p.widthPx, target.h / p.heightPx); // contain
    const dpi = 1 / scale;
    if (dpi < 200) {
      issues.push({ level: 'error', code: 'low-resolution', page: n, message: `Page ${n} prints at ~${Math.round(dpi)} dpi (${p.widthPx}x${p.heightPx}px). KDP wants 300; below 200 it will look blurry. Upscale it (upscale_image) or regenerate larger.` });
    } else if (dpi < 290) {
      issues.push({ level: 'warning', code: 'soft-resolution', page: n, message: `Page ${n} prints at ~${Math.round(dpi)} dpi — acceptable, but 300 is the standard. ${p.widthPx}x${p.heightPx}px.` });
    }
    // Aspect mismatch: a square image on a portrait page leaves bands.
    const pageRatio = target.w / target.h;
    const imgRatio = p.widthPx / p.heightPx;
    if (Math.abs(pageRatio - imgRatio) / pageRatio > 0.12) {
      issues.push({
        level: book.bleed ? 'warning' : 'warning',
        code: 'aspect-mismatch',
        page: n,
        message: book.bleed
          ? `Page ${n} is ${imgRatio.toFixed(2)}:1 but the bleed page is ${pageRatio.toFixed(2)}:1 — it will be cropped to fill.`
          : `Page ${n} is ${imgRatio.toFixed(2)}:1 but the printable area is ${pageRatio.toFixed(2)}:1 — it will be letterboxed with white.`,
      });
    }
  });

  return issues;
}

export function hasErrors(issues: PreflightIssue[]): boolean {
  return issues.some(i => i.level === 'error');
}
