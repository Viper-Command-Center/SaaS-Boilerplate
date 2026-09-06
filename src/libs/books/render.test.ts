/**
 * End-to-end render checks: a synthetic "coloring page" (grey, noisy, with
 * alpha) goes through line-art cleanup, an interior PDF and a full-wrap
 * cover, and the PDFs are re-opened to verify KDP geometry. Real pixels,
 * real pdf-lib output — no mocks — because the failure mode here is a file
 * KDP rejects, not a thrown error.
 */

import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { extractPdfImages } from '@/libs/docs/pdfImages';
import { renderCover } from './cover';
import { expandPages, renderInterior } from './interior';
import { coverGeometry, parseTrim } from './kdp';
import { prepareLineArt } from './lineArt';

/** A grey circle with soft edges and speckles on a transparent background. */
async function fakeDrawing(size = 900): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.3}" fill="none" stroke="#555" stroke-width="18"/>
    <rect x="${size * 0.2}" y="${size * 0.2}" width="${size * 0.1}" height="${size * 0.1}" fill="#bbb"/>
    <circle cx="${size * 0.8}" cy="${size * 0.15}" r="2" fill="#000"/>
    <circle cx="${size * 0.1}" cy="${size * 0.9}" r="2" fill="#000"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const trim = parseTrim('8.5x8.5')!;

describe('prepareLineArt', () => {
  it('produces pure black/white at the requested size, on a white ground', async () => {
    const src = await fakeDrawing();
    const r = await prepareLineArt(src, { targetPx: { width: 2550, height: 2550 } });

    expect(r.width).toBe(2550);
    expect(r.height).toBe(2550);
    expect(r.inkCoverage).toBeGreaterThan(0.005);
    expect(r.inkCoverage).toBeLessThan(0.2);

    const { data, info } = await sharp(r.png).raw().toBuffer({ resolveWithObject: true });
    const values = new Set<number>();
    for (let i = 0; i < data.length; i += info.channels) {
      values.add(data[i]!);
    }

    // only two grey levels survive the threshold
    expect([...values].every(v => v === 0 || v === 255)).toBe(true);
    // the alpha background became WHITE, not black
    expect(data[0]).toBe(255);
  });

  it('keeps tones when asked', async () => {
    const src = await fakeDrawing(300);
    const r = await prepareLineArt(src, { keepTones: true });

    expect(Number.isNaN(r.inkCoverage)).toBe(true);
    expect(r.width).toBe(300);
  });
});

describe('renderInterior', () => {
  it('lays out a single-sided no-bleed coloring book at KDP page size', async () => {
    const art = await fakeDrawing(600);
    const logical = Array.from({ length: 12 }, () => ({ kind: 'art' as const, bytes: art }));
    const pages = expandPages([{ kind: 'text', heading: 'Cats!', lines: ['by Ava'] }, ...logical], { singleSided: true });

    // 1 text + 12 art + 12 blanks = 25 → padded to 26
    expect(pages).toHaveLength(26);

    const r = await renderInterior({ trim, bleed: false, paper: 'white', ink: 'black', pages, lineArt: true, title: 'Cats!' });
    const doc = await PDFDocument.load(r.pdf);

    expect(doc.getPageCount()).toBe(26);

    const { width, height } = doc.getPage(0).getSize();

    expect(width).toBeCloseTo(8.5 * 72, 1);
    expect(height).toBeCloseTo(8.5 * 72, 1);
    expect(r.fontsEmbedded).toBe(true);
    // 12 black/white palette PNG pages stay small
    expect(r.bytes).toBeLessThan(3 * 1024 * 1024);
  }, 60_000);

  it('adds bleed to the page box when bleed is on', async () => {
    const art = await fakeDrawing(400);
    const r = await renderInterior({ trim, bleed: true, paper: 'white', ink: 'black', pages: [{ kind: 'art', bytes: art }, { kind: 'blank' }], lineArt: true, title: 'x' });
    const { width, height } = (await PDFDocument.load(r.pdf)).getPage(0).getSize();

    expect(width).toBeCloseTo(8.625 * 72, 1);
    expect(height).toBeCloseTo(8.75 * 72, 1);
  }, 30_000);
});

describe('renderCover', () => {
  it('renders a full-wrap cover at the calculator size with a clear barcode box', async () => {
    const art = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#ff8800' } }).png().toBuffer();
    const pageCount = 60;
    const r = await renderCover({
      trim,
      pageCount,
      paper: 'white',
      ink: 'black',
      title: 'Happy Cats Coloring Book',
      subtitle: '30 playful kittens to colour',
      author: 'Ava Mahabir',
      blurb: 'Thirty friendly cats wait for your crayons. Single-sided pages so markers never bleed through.',
      spineText: true, // must be dropped: 60 < 79
      frontArt: art,
      background: '#ffe066',
      textColor: '#222222',
    });
    const g = coverGeometry({ trim, pageCount, paper: 'white', ink: 'black' });

    expect(r.widthPx).toBe(Math.round(g.widthIn * 300));
    expect(r.heightPx).toBe(Math.round(g.heightIn * 300));
    expect(r.notes.some(n => n.includes('Spine text skipped'))).toBe(true);

    const { width, height } = (await PDFDocument.load(r.pdf)).getPage(0).getSize();

    expect(width).toBeCloseTo(g.widthIn * 72, 0);
    expect(height).toBeCloseTo(g.heightIn * 72, 0);

    // sample the middle of the barcode zone: must be white
    const bx = Math.round((g.barcode.xIn + g.barcode.widthIn / 2) * 300);
    const by = Math.round((g.heightIn - g.barcode.yIn - g.barcode.heightIn / 2) * 300); // canvas y is top-down
    const px = await sharp(r.fullPng).extract({ left: bx, top: by, width: 1, height: 1 }).raw().toBuffer();

    expect([px[0], px[1], px[2]]).toEqual([255, 255, 255]);

    // sample the front art area: orange, not the yellow background
    const fx = Math.round((g.front.xIn + 0.3) * 300);
    const fy = Math.round((g.heightIn / 2) * 300);
    const fp = await sharp(r.fullPng).extract({ left: fx, top: fy, width: 1, height: 1 }).raw().toBuffer();

    expect(fp[0]).toBe(255);
    expect(fp[1]).toBeLessThan(160);
  }, 60_000);
});

describe('extractPdfImages', () => {
  it('pulls page images back out of a PDF in page order (PNG and JPEG)', async () => {
    const png = await fakeDrawing(300);
    const jpg = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#3366cc' } }).jpeg().toBuffer();
    const doc = await PDFDocument.create();
    const p1 = doc.addPage([300, 300]);
    p1.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 300, height: 300 });
    const p2 = doc.addPage([320, 200]);
    p2.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: 320, height: 200 });
    const bytes = Buffer.from(await doc.save());

    const r = await extractPdfImages(bytes);

    expect(r.pageCount).toBe(2);
    expect(r.images.map(i => [i.page, i.ext, i.width, i.height])).toEqual([[1, 'png', 300, 300], [2, 'jpg', 320, 200]]);
    expect(r.skipped).toEqual([]);

    const meta = await sharp(r.images[0]!.bytes).metadata();

    expect(meta.width).toBe(300);
  });
});
