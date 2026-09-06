/**
 * Extract the raster images embedded in a PDF — page by page, in order.
 *
 * Why: a Canva / InDesign / Word "export to PDF" of a picture book is one
 * image per page. There is no PDF rasteriser in this stack (pdf.js needs a
 * canvas; Chrome is unverified in prod), but we do not need one: the PDF
 * already CONTAINS the page images as XObjects, and pdf-lib can walk them.
 * Pulling those out loses nothing, unlike re-rendering the page.
 *
 * Handles what real exporters write: DCTDecode (JPEG passthrough), Flate
 * RGB / Gray / CMYK / Indexed at 8 bits, 1-bit gray. JPX, 16-bit and exotic
 * colour spaces are reported in `skipped` with the reason, never guessed.
 */

import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import sharp from 'sharp';

export type PdfImage = {
  page: number; // 1-based
  order: number; // 1-based across the document
  bytes: Buffer;
  mime: 'image/png' | 'image/jpeg';
  ext: 'png' | 'jpg';
  width: number;
  height: number;
};

export type PdfImageResult = {
  images: PdfImage[];
  skipped: Array<{ page: number; reason: string }>;
  pageCount: number;
};

export const MAX_PDF_IMAGES = 400;
/** Ignore tiny XObjects (logos, bullets) — a page image is never this small. */
const MIN_SIDE = 64;

export async function extractPdfImages(bytes: Buffer, opts: { max?: number } = {}): Promise<PdfImageResult> {
  const max = opts.max ?? MAX_PDF_IMAGES;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const images: PdfImage[] = [];
  const skipped: Array<{ page: number; reason: string }> = [];
  const seen = new Set<string>();

  for (let pi = 0; pi < pages.length; pi++) {
    const pageNo = pi + 1;
    const resources = pages[pi]!.node.Resources();
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xobjects) {
      continue;
    }
    for (const [, value] of xobjects.entries()) {
      if (images.length >= max) {
        break;
      }
      const key = value instanceof PDFRef ? value.toString() : null;
      const stream = doc.context.lookup(value);
      if (!(stream instanceof PDFStream)) {
        continue;
      }
      const dict = stream.dict;
      if (dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Image') {
        continue;
      }
      // The same XObject reused on several pages (a border, a logo) counts once.
      if (key) {
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
      }
      try {
        const img = await decodeImage(doc, stream);
        if (!img) {
          continue;
        }
        if (img.width < MIN_SIDE || img.height < MIN_SIDE) {
          continue;
        }
        images.push({ page: pageNo, order: images.length + 1, ...img });
      } catch (err) {
        skipped.push({ page: pageNo, reason: err instanceof Error ? err.message : 'undecodable image' });
      }
    }
  }
  return { images, skipped, pageCount: pages.length };
}

async function decodeImage(doc: PDFDocument, stream: PDFStream): Promise<Omit<PdfImage, 'page' | 'order'> | null> {
  const dict = stream.dict;
  const width = num(dict, 'Width');
  const height = num(dict, 'Height');
  if (!width || !height) {
    return null;
  }
  const filters = filterNames(dict);
  const last = filters[filters.length - 1];

  if (last === 'DCTDecode') {
    if (!(stream instanceof PDFRawStream)) {
      throw new TypeError('JPEG stream is not raw');
    }
    // JPEG bytes are usable as-is. CMYK JPEGs (print exporters) are converted
    // so the result is an ordinary sRGB file every downstream tool accepts.
    const raw = Buffer.from(stream.contents);
    const meta = await sharp(raw).metadata();
    if (meta.space === 'cmyk' || (meta.channels ?? 3) === 4) {
      const png = await sharp(raw).toColourspace('srgb').png().toBuffer();
      return { bytes: png, mime: 'image/png', ext: 'png', width, height };
    }
    return { bytes: raw, mime: 'image/jpeg', ext: 'jpg', width, height };
  }
  if (last === 'JPXDecode') {
    throw new Error('JPEG 2000 (JPX) images are not supported — re-export the PDF with standard JPEG/PNG images');
  }
  if (last && !['FlateDecode', 'LZWDecode', 'RunLengthDecode'].includes(last)) {
    throw new Error(`unsupported image filter ${last}`);
  }

  if (!(stream instanceof PDFRawStream)) {
    throw new TypeError('image stream is not raw');
  }
  const data = Buffer.from(decodePDFRawStream(stream).decode());
  const bpc = num(dict, 'BitsPerComponent') ?? 8;
  const cs = colorSpace(doc, dict);

  if (bpc === 1 && cs.kind === 'gray') {
    // 1 bit per pixel, rows padded to byte boundary. Expand to 8-bit.
    const rowBytes = Math.ceil(width / 8);
    const out = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)]! >> (7 - (x & 7))) & 1;
        out[y * width + x] = bit ? 255 : 0;
      }
    }
    const png = await sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer();
    return { bytes: png, mime: 'image/png', ext: 'png', width, height };
  }
  if (bpc !== 8) {
    throw new Error(`${bpc}-bit images are not supported`);
  }

  let rgb: Buffer;
  let channels: 1 | 3;
  if (cs.kind === 'gray') {
    rgb = data.subarray(0, width * height);
    channels = 1;
  } else if (cs.kind === 'rgb') {
    rgb = data.subarray(0, width * height * 3);
    channels = 3;
  } else if (cs.kind === 'cmyk') {
    const n = width * height;
    rgb = Buffer.alloc(n * 3);
    for (let i = 0; i < n; i++) {
      const c = data[i * 4]! / 255;
      const m = data[i * 4 + 1]! / 255;
      const yy = data[i * 4 + 2]! / 255;
      const k = data[i * 4 + 3]! / 255;
      rgb[i * 3] = Math.round(255 * (1 - c) * (1 - k));
      rgb[i * 3 + 1] = Math.round(255 * (1 - m) * (1 - k));
      rgb[i * 3 + 2] = Math.round(255 * (1 - yy) * (1 - k));
    }
    channels = 3;
  } else if (cs.kind === 'indexed') {
    const n = width * height;
    const bc = cs.baseChannels;
    rgb = Buffer.alloc(n * 3);
    for (let i = 0; i < n; i++) {
      const idx = data[i]!;
      if (bc === 1) {
        const v = cs.palette[idx] ?? 0;
        rgb[i * 3] = v;
        rgb[i * 3 + 1] = v;
        rgb[i * 3 + 2] = v;
      } else {
        rgb[i * 3] = cs.palette[idx * bc] ?? 0;
        rgb[i * 3 + 1] = cs.palette[idx * bc + 1] ?? 0;
        rgb[i * 3 + 2] = cs.palette[idx * bc + 2] ?? 0;
      }
    }
    channels = 3;
  } else {
    throw new Error(`unsupported colour space ${cs.name}`);
  }
  if (rgb.length < width * height * channels) {
    throw new Error('image data is shorter than its declared size');
  }
  const png = await sharp(rgb, { raw: { width, height, channels } }).png().toBuffer();
  return { bytes: png, mime: 'image/png', ext: 'png', width, height };
}

function num(dict: PDFDict, key: string): number | undefined {
  const v = dict.lookupMaybe(PDFName.of(key), PDFNumber);
  return v ? v.asNumber() : undefined;
}

function filterNames(dict: PDFDict): string[] {
  const f = dict.lookup(PDFName.of('Filter'));
  if (f instanceof PDFName) {
    return [f.asString().slice(1)];
  }
  if (f instanceof PDFArray) {
    return f.asArray().map(x => (x instanceof PDFName ? x.asString().slice(1) : ''));
  }
  return [];
}

type ColorSpace
  = | { kind: 'gray' | 'rgb' | 'cmyk'; name: string }
    | { kind: 'indexed'; name: string; baseChannels: 1 | 3 | 4; palette: Uint8Array }
    | { kind: 'other'; name: string };

function colorSpace(doc: PDFDocument, dict: PDFDict): ColorSpace {
  const raw = dict.lookup(PDFName.of('ColorSpace'));
  return resolveColorSpace(doc, raw);
}

function resolveColorSpace(doc: PDFDocument, raw: unknown): ColorSpace {
  if (raw instanceof PDFName) {
    const n = raw.asString();
    if (n === '/DeviceGray' || n === '/CalGray' || n === '/G') {
      return { kind: 'gray', name: n };
    }
    if (n === '/DeviceRGB' || n === '/CalRGB' || n === '/RGB') {
      return { kind: 'rgb', name: n };
    }
    if (n === '/DeviceCMYK' || n === '/CMYK') {
      return { kind: 'cmyk', name: n };
    }
    return { kind: 'other', name: n };
  }
  if (raw instanceof PDFArray) {
    const first = raw.get(0);
    const family = first instanceof PDFName ? first.asString() : '';
    if (family === '/ICCBased') {
      const s = doc.context.lookup(raw.get(1));
      const n = s instanceof PDFStream ? num(s.dict, 'N') : undefined;
      return n === 1 ? { kind: 'gray', name: 'ICC gray' } : n === 4 ? { kind: 'cmyk', name: 'ICC cmyk' } : { kind: 'rgb', name: 'ICC rgb' };
    }
    if (family === '/Indexed' || family === '/I') {
      const base = resolveColorSpace(doc, doc.context.lookup(raw.get(1)));
      const baseChannels = base.kind === 'gray' ? 1 : base.kind === 'cmyk' ? 4 : 3;
      const lookup = doc.context.lookup(raw.get(3));
      let palette: Uint8Array;
      if (lookup instanceof PDFRawStream) {
        palette = decodePDFRawStream(lookup).decode();
      } else if (lookup && typeof (lookup as unknown as { asBytes?: () => Uint8Array }).asBytes === 'function') {
        palette = (lookup as unknown as { asBytes: () => Uint8Array }).asBytes();
      } else {
        return { kind: 'other', name: 'Indexed (unreadable palette)' };
      }
      if (baseChannels === 4) {
        // convert CMYK palette to RGB once
        const n = palette.length / 4;
        const p = new Uint8Array(n * 3);
        for (let i = 0; i < n; i++) {
          const k = palette[i * 4 + 3]! / 255;
          p[i * 3] = Math.round(255 * (1 - palette[i * 4]! / 255) * (1 - k));
          p[i * 3 + 1] = Math.round(255 * (1 - palette[i * 4 + 1]! / 255) * (1 - k));
          p[i * 3 + 2] = Math.round(255 * (1 - palette[i * 4 + 2]! / 255) * (1 - k));
        }
        return { kind: 'indexed', name: 'Indexed', baseChannels: 3, palette: p };
      }
      return { kind: 'indexed', name: 'Indexed', baseChannels, palette };
    }
    return { kind: 'other', name: family || 'array' };
  }
  if (raw instanceof PDFRef) {
    return resolveColorSpace(doc, doc.context.lookup(raw));
  }
  // No /ColorSpace: an image mask or something odd — treat as gray.
  return { kind: 'gray', name: 'none' };
}
