/**
 * Line-art preparation — turns an AI-generated or scanned coloring page into
 * print-grade black-on-white.
 *
 * Why this exists: image models drift into grey shading, anti-aliased fuzz
 * and stray specks. On a home screen that reads as "sketchy"; on KDP's
 * black-ink press it prints as muddy grey blocks and dots the child cannot
 * colour around. A real coloring book is PURE black and PURE white, so the
 * fix is a threshold — plus a despeckle so the threshold doesn't turn noise
 * into confetti — plus a resample to the exact pixel size the page needs.
 *
 * sharp (libvips) does all of it in a few hundred ms per page. Nothing here
 * calls a model; it is deterministic and free.
 */

import sharp from 'sharp';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

export type LineArtOptions = {
  /** 0–255 luminance cut. Higher keeps fainter lines. Default 160. */
  threshold?: number;
  /** Median filter radius for despeckle; 0 disables. Default 1 (3x3). */
  despeckle?: number;
  /** Thicken lines by this many pixels (0 = leave). Helps thin AI output. */
  thicken?: number;
  /** Output size. Omit to keep the source size (after auto-orient). */
  targetPx?: { width: number; height: number };
  /** 'contain' pads with white to the target box, 'cover' crops to fill. */
  fit?: 'contain' | 'cover';
  /** Skip the threshold entirely — for grayscale/colour art that must stay so. */
  keepTones?: boolean;
};

export type LineArtResult = {
  png: Buffer;
  width: number;
  height: number;
  /** share of pixels that are black — 0.02–0.25 is a normal coloring page */
  inkCoverage: number;
};

export async function prepareLineArt(input: Buffer, opts: LineArtOptions = {}): Promise<LineArtResult> {
  const threshold = clamp(opts.threshold ?? 160, 1, 254);
  const despeckle = clamp(opts.despeckle ?? 1, 0, 3);
  const thicken = clamp(opts.thicken ?? 0, 0, 4);

  let img = sharp(input, { failOn: 'none' }).rotate(); // honour EXIF orientation
  // Flatten transparency onto white: PNGs from generators often carry alpha,
  // and alpha thresholds as black.
  img = img.flatten({ background: '#ffffff' });

  if (!opts.keepTones) {
    img = img.grayscale();
    if (despeckle > 0) {
      img = img.median(despeckle * 2 + 1);
    }
    img = img.threshold(threshold);
    if (thicken > 0) {
      // Erode white = dilate black. libvips has no morphology in sharp's API,
      // so approximate with a min-filter via a small blur + re-threshold.
      img = img.blur(thicken * 0.6).threshold(200);
    }
  }

  if (opts.targetPx) {
    img = img.resize({
      width: opts.targetPx.width,
      height: opts.targetPx.height,
      fit: opts.fit === 'cover' ? 'cover' : 'contain',
      background: '#ffffff',
      kernel: 'lanczos3',
      withoutEnlargement: false,
    });
    if (!opts.keepTones) {
      // resampling re-introduces grey at the edges — cut once more
      img = img.threshold(threshold);
    }
  }

  const { data, info } = await img.png({ compressionLevel: 9, palette: !opts.keepTones }).toBuffer({ resolveWithObject: true });

  const inkCoverage = opts.keepTones ? Number.NaN : await measureInk(data);
  return { png: data, width: info.width, height: info.height, inkCoverage };
}

/** Share of black pixels, sampled on a 400px-wide copy (cost, not accuracy). */
async function measureInk(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).grayscale().resize({ width: 400, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if ((data[i] ?? 255) < 128) {
      dark++;
    }
  }
  return Math.round((dark / (info.width * info.height)) * 1000) / 1000;
}

export async function imageSize(bytes: Buffer): Promise<{ width: number; height: number; format: string } | null> {
  try {
    const m = await sharp(bytes, { failOn: 'none' }).metadata();
    if (!m.width || !m.height) {
      return null;
    }
    // EXIF orientation 5–8 swap the axes
    const swapped = (m.orientation ?? 1) >= 5;
    return { width: swapped ? m.height : m.width, height: swapped ? m.width : m.height, format: m.format ?? 'unknown' };
  } catch {
    return null;
  }
}
