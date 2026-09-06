import { describe, expect, it } from 'vitest';
import { coverGeometry, gutterIn, interiorPageIn, interiorSafeBoxIn, pageLimits, parseTrim, preflight, spineWidthIn } from './kdp';

describe('trim parsing', () => {
  it('reads the ways people write a size', () => {
    expect(parseTrim('8.5x8.5')).toMatchObject({ widthIn: 8.5, heightIn: 8.5 });
    expect(parseTrim('8.5 x 11 in')).toMatchObject({ widthIn: 8.5, heightIn: 11 });
    expect(parseTrim('6×9')).toMatchObject({ widthIn: 6, heightIn: 9 });
    expect(parseTrim('a4')?.label).toMatch(/^A4/);
    expect(parseTrim('letter')).toBeNull();
    expect(parseTrim('0x9')).toBeNull();
  });

  it('labels a non-KDP size as custom', () => {
    expect(parseTrim('7x7')?.label).toContain('custom');
    expect(parseTrim('8.5x8.5')?.label).not.toContain('custom');
  });
});

describe('interior geometry (KDP paperback guidelines)', () => {
  it('adds bleed on one width edge and both height edges', () => {
    expect(interiorPageIn({ widthIn: 6, heightIn: 9, label: '' }, true)).toEqual({ widthIn: 6.125, heightIn: 9.25 });
    expect(interiorPageIn({ widthIn: 6, heightIn: 9, label: '' }, false)).toEqual({ widthIn: 6, heightIn: 9 });
  });

  it('uses KDP\'s gutter table', () => {
    expect(gutterIn(24)).toBe(0.375);
    expect(gutterIn(150)).toBe(0.375);
    expect(gutterIn(151)).toBe(0.5);
    expect(gutterIn(300)).toBe(0.5);
    expect(gutterIn(301)).toBe(0.625);
    expect(gutterIn(501)).toBe(0.75);
    expect(gutterIn(701)).toBe(0.875);
  });

  it('puts the gutter on the spine side of each page', () => {
    const trim = parseTrim('8.5x8.5')!;
    const right = interiorSafeBoxIn({ trim, bleed: false, pageCount: 60, pageNumber: 1 });
    const left = interiorSafeBoxIn({ trim, bleed: false, pageCount: 60, pageNumber: 2 });

    // page 1 is a right-hand page: gutter (0.375) on the left, outside (0.25) on the right
    expect(right.xIn).toBe(0.375);
    expect(right.widthIn).toBeCloseTo(8.5 - 0.375 - 0.25, 5);
    // page 2 is a left-hand page: the mirror
    expect(left.xIn).toBe(0.25);
    expect(left.widthIn).toBeCloseTo(8.5 - 0.375 - 0.25, 5);
  });

  it('keeps 0.375 in from the trim when bleed is on', () => {
    const trim = parseTrim('8.5x8.5')!;
    const box = interiorSafeBoxIn({ trim, bleed: true, pageCount: 60, pageNumber: 1 });

    // outside margin 0.375 + bleed 0.125 = 0.5 from the page-box edge
    expect(box.yIn).toBe(0.5);
    expect(box.heightIn).toBeCloseTo(8.75 - 1, 5);
  });

  it('knows the page-count limits per ink and paper', () => {
    expect(pageLimits('black', 'white')).toEqual({ min: 24, max: 828 });
    expect(pageLimits('black', 'cream')).toEqual({ min: 24, max: 776 });
    expect(pageLimits('color-standard', 'white')).toEqual({ min: 72, max: 600 });
  });
});

describe('cover geometry (KDP cover calculator)', () => {
  it('sizes the spine from the page count and paper', () => {
    expect(spineWidthIn(100, 'white', 'black')).toBeCloseTo(0.2252, 4);
    expect(spineWidthIn(100, 'cream', 'black')).toBeCloseTo(0.25, 4);
    expect(spineWidthIn(100, 'white', 'color-premium')).toBeCloseTo(0.2347, 4);
  });

  it('matches KDP\'s worked example: 6x9, 100 pages white → 12.475 x 9.25', () => {
    const g = coverGeometry({ trim: parseTrim('6x9')!, pageCount: 100, paper: 'white', ink: 'black' });

    expect(g.widthIn).toBeCloseTo(12.4752, 3);
    expect(g.heightIn).toBe(9.25);
    expect(g.front.xIn).toBeCloseTo(0.125 + 6 + 0.2252, 4);
    expect(g.spineTextAllowed).toBe(true);
  });

  it('keeps the barcode block bottom-right of the back cover, inside the trim', () => {
    const g = coverGeometry({ trim: parseTrim('8.5x8.5')!, pageCount: 60, paper: 'white', ink: 'black' });

    expect(g.barcode.xIn + g.barcode.widthIn).toBeCloseTo(g.back.xIn + g.back.widthIn - 0.25, 5);
    expect(g.barcode.yIn).toBeCloseTo(g.back.yIn + 0.25, 5);
    expect(g.spineTextAllowed).toBe(false); // < 79 pages
  });
});

describe('preflight', () => {
  const trim = parseTrim('8.5x8.5')!;
  const page = (n: number, px = 2550) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? { kind: 'art' as const, widthPx: px, heightPx: px } : { kind: 'blank' as const }));

  it('passes a well-formed coloring book', () => {
    const issues = preflight({ trim, bleed: false, paper: 'white', ink: 'black', pages: page(40), hasCoverArt: true, title: 'Cats' });

    expect(issues.filter(i => i.level === 'error')).toEqual([]);
  });

  it('rejects too few pages and says how KDP counts', () => {
    const issues = preflight({ trim, bleed: false, paper: 'white', ink: 'black', pages: page(10), hasCoverArt: true, title: 'Cats' });

    expect(issues.find(i => i.code === 'too-few-pages')?.message).toContain('24');
  });

  it('flags low-resolution art for the box it fills', () => {
    const issues = preflight({ trim, bleed: false, paper: 'white', ink: 'black', pages: page(40, 800), hasCoverArt: true, title: 'Cats' });

    expect(issues.some(i => i.code === 'low-resolution' && i.page === 1)).toBe(true);
  });

  it('warns about spine text under 79 pages and missing cover', () => {
    const issues = preflight({ trim, bleed: false, paper: 'white', ink: 'black', pages: page(40), hasCoverArt: false, title: 'Cats', spineText: 'Cats' });

    expect(issues.some(i => i.code === 'no-cover' && i.level === 'error')).toBe(true);
    expect(issues.some(i => i.code === 'spine-text-too-thin')).toBe(true);
  });

  it('refuses colour ink on cream paper', () => {
    const issues = preflight({ trim, bleed: false, paper: 'cream', ink: 'color-standard', pages: page(80), hasCoverArt: true, title: 'Cats' });

    expect(issues.some(i => i.code === 'cream-color')).toBe(true);
  });
});
