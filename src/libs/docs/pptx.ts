/**
 * PowerPoint generation — a slide SPEC in, a real .pptx out.
 *
 * WHY A SEPARATE PATH FROM PDF. These are not the same problem and cannot share
 * a renderer. A PDF is a picture of a finished page, so HTML + Chrome is the
 * right tool. A .pptx is a ZIP of OOXML that PowerPoint re-flows and the client
 * EDITS — there is no HTML-to-pptx conversion worth having, and going through
 * PDF produces a deck of flat images, which is precisely what a client asking
 * for "the deck" does not want. pptxgenjs writes the OOXML directly, in pure
 * JS, with no browser and no native dependency.
 *
 * WHY A SPEC AND NOT THE RAW API. pptxgenjs positions everything in inches from
 * the top-left. Handing the agent x/y/w/h means it invents coordinates, and
 * overlapping text boxes look like a rendering bug rather than a prompt that
 * guessed badly. The layouts below own all geometry: the agent supplies content
 * and picks a shape, exactly as it would in the real application.
 *
 * Everything is 16:9 (13.333 x 7.5in). pptxgenjs defaults to 4:3, which looks
 * obviously wrong on any screen made in the last fifteen years.
 */

import { Buffer } from 'node:buffer';
import PptxGenJS from 'pptxgenjs';

/** 16:9 at pptxgenjs's inch scale. */
const W = 13.333;
const H = 7.5;
const MARGIN = 0.9;

export type SlideSpec = {
  layout?: 'title' | 'bullets' | 'table' | 'image' | 'quote' | 'section' | 'blank';
  title?: string;
  subtitle?: string;
  bullets?: string[];
  table?: { headers?: string[]; rows: string[][] };
  imageUrl?: string;
  caption?: string;
  /** Presenter notes — invisible on the slide, visible in presenter view. */
  notes?: string;
};

export type DeckSpec = {
  title: string;
  subtitle?: string;
  theme?: {
    /** Hex, with or without '#'. */
    background?: string;
    text?: string;
    muted?: string;
    accent?: string;
    fontFace?: string;
  };
  slides: SlideSpec[];
};

export type DeckResult = { pptx: Buffer; bytes: number; slideCount: number };

const DEFAULT_THEME = {
  background: '0F172A',
  text: 'FFFFFF',
  muted: '94A3B8',
  accent: '38BDF8',
  fontFace: 'Segoe UI',
};

/**
 * pptxgenjs wants BARE hex — 'FF0000', never '#FF0000'.
 *
 * A leading '#' is not rejected; it produces a colour PowerPoint cannot parse,
 * and the text renders black on a black background. Since every human and every
 * model writes '#RRGGBB' by reflex, normalising here is the difference between
 * "the deck works" and "the deck is blank".
 */
function hex(value: string | undefined, fallback: string): string {
  const raw = String(value ?? '').trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{6}$/.test(raw)) {
    return raw;
  }
  if (/^[0-9A-F]{3}$/.test(raw)) {
    return raw.split('').map(c => c + c).join('');
  }
  return fallback;
}

/** Fetch an image and inline it as a data URL. */
async function fetchImage(url: string): Promise<string | null> {
  // Rendering must not hang on someone else's slow CDN, and a missing image is
  // never worth failing an entire deck over — the slide degrades to its caption.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      return null;
    }
    const type = resp.headers.get('content-type') ?? 'image/png';
    if (!/^image\//i.test(type)) {
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) {
      return null;
    }
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function renderDeck(spec: DeckSpec): Promise<DeckResult> {
  if (!spec?.title) {
    throw new Error('The deck needs a title.');
  }
  const slides = Array.isArray(spec.slides) ? spec.slides : [];
  if (!slides.length) {
    throw new Error('The deck needs at least one slide.');
  }
  if (slides.length > 100) {
    throw new Error(`${slides.length} slides is beyond what this is for — split it into several decks.`);
  }

  const theme = {
    background: hex(spec.theme?.background, DEFAULT_THEME.background),
    text: hex(spec.theme?.text, DEFAULT_THEME.text),
    muted: hex(spec.theme?.muted, DEFAULT_THEME.muted),
    accent: hex(spec.theme?.accent, DEFAULT_THEME.accent),
    fontFace: spec.theme?.fontFace || DEFAULT_THEME.fontFace,
  };

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'ARTIVIO16x9', width: W, height: H });
  pptx.layout = 'ARTIVIO16x9';
  pptx.title = spec.title;

  const contentWidth = W - MARGIN * 2;

  // Cover slide, always first — a deck opening straight into bullets reads as
  // a fragment someone forwarded rather than a document.
  const cover = pptx.addSlide();
  cover.background = { color: theme.background };
  cover.addText(spec.title, {
    x: MARGIN, y: 2.5, w: contentWidth, h: 1.6,
    fontSize: 48, bold: true, color: theme.text, fontFace: theme.fontFace,
  });
  if (spec.subtitle) {
    cover.addText(spec.subtitle, {
      x: MARGIN, y: 4.1, w: contentWidth, h: 0.9,
      fontSize: 22, color: theme.muted, fontFace: theme.fontFace,
    });
  }
  cover.addShape('rect', { x: MARGIN, y: 2.15, w: 1.6, h: 0.09, fill: { color: theme.accent } });

  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: theme.background };
    const layout = s.layout ?? (s.table ? 'table' : s.imageUrl ? 'image' : s.bullets?.length ? 'bullets' : 'section');

    if (s.notes) {
      slide.addNotes(String(s.notes));
    }

    // A section divider centres its title and shows nothing else.
    if (layout === 'section') {
      slide.addText(String(s.title ?? ''), {
        x: MARGIN, y: 3.0, w: contentWidth, h: 1.5,
        fontSize: 40, bold: true, color: theme.text, fontFace: theme.fontFace, align: 'center',
      });
      if (s.subtitle) {
        slide.addText(String(s.subtitle), {
          x: MARGIN, y: 4.4, w: contentWidth, h: 0.8,
          fontSize: 20, color: theme.muted, fontFace: theme.fontFace, align: 'center',
        });
      }
      continue;
    }

    if (layout === 'quote') {
      slide.addText(`“${String(s.title ?? '')}”`, {
        x: MARGIN, y: 2.4, w: contentWidth, h: 2.2,
        fontSize: 34, italic: true, color: theme.text, fontFace: theme.fontFace,
      });
      if (s.subtitle) {
        slide.addText(`— ${String(s.subtitle)}`, {
          x: MARGIN, y: 4.7, w: contentWidth, h: 0.6,
          fontSize: 18, color: theme.muted, fontFace: theme.fontFace,
        });
      }
      continue;
    }

    // Every remaining layout carries a heading in the same place.
    if (s.title) {
      slide.addText(String(s.title), {
        x: MARGIN, y: 0.7, w: contentWidth, h: 0.9,
        fontSize: 32, bold: true, color: theme.text, fontFace: theme.fontFace,
      });
      slide.addShape('rect', { x: MARGIN, y: 1.62, w: 1.1, h: 0.06, fill: { color: theme.accent } });
    }

    const bodyY = s.title ? 2.05 : 1.0;
    const bodyH = H - bodyY - 0.7;

    if (layout === 'bullets' && s.bullets?.length) {
      const items = s.bullets.slice(0, 10).map(b => String(b));
      // Shrink as the list grows: 10 bullets at 20pt overflow the slide, and
      // PowerPoint does not warn — it just draws them past the bottom edge.
      const fontSize = items.length > 7 ? 15 : items.length > 5 ? 17 : 20;
      slide.addText(
        items.map(text => ({ text, options: { bullet: true, breakLine: true } })),
        {
          x: MARGIN, y: bodyY, w: contentWidth, h: bodyH,
          fontSize, color: theme.text, fontFace: theme.fontFace, lineSpacingMultiple: 1.35, valign: 'top',
        },
      );
      continue;
    }

    if (layout === 'table' && s.table?.rows?.length) {
      const headers = s.table.headers ?? [];
      const rows: PptxGenJS.TableRow[] = [];
      if (headers.length) {
        rows.push(headers.map(h => ({
          text: String(h),
          options: { bold: true, color: theme.background, fill: { color: theme.accent } },
        })));
      }
      for (const r of s.table.rows.slice(0, 14)) {
        rows.push(r.map(c => ({ text: String(c ?? ''), options: { color: theme.text } })));
      }
      slide.addTable(rows, {
        x: MARGIN, y: bodyY, w: contentWidth,
        fontSize: rows.length > 9 ? 12 : 14,
        fontFace: theme.fontFace,
        border: { type: 'solid', color: '334155', pt: 1 },
        autoPage: false,
      });
      continue;
    }

    if (layout === 'image' && s.imageUrl) {
      const data = await fetchImage(String(s.imageUrl));
      if (data) {
        slide.addImage({
          data,
          x: MARGIN, y: bodyY, w: contentWidth, h: bodyH - (s.caption ? 0.5 : 0),
          sizing: { type: 'contain', w: contentWidth, h: bodyH - (s.caption ? 0.5 : 0) },
        });
      } else {
        // Say so on the slide. A silently missing image is discovered by the
        // client, in the meeting.
        slide.addText(`[image could not be loaded: ${String(s.imageUrl).slice(0, 80)}]`, {
          x: MARGIN, y: bodyY, w: contentWidth, h: 0.6,
          fontSize: 14, color: theme.muted, fontFace: theme.fontFace, italic: true,
        });
      }
      if (s.caption) {
        slide.addText(String(s.caption), {
          x: MARGIN, y: H - 1.1, w: contentWidth, h: 0.5,
          fontSize: 14, color: theme.muted, fontFace: theme.fontFace,
        });
      }
      continue;
    }

    // 'blank', or a layout whose content was missing: fall back to the subtitle
    // rather than emitting an empty slide with no explanation.
    if (s.subtitle) {
      slide.addText(String(s.subtitle), {
        x: MARGIN, y: bodyY, w: contentWidth, h: bodyH,
        fontSize: 20, color: theme.muted, fontFace: theme.fontFace, valign: 'top',
      });
    }
  }

  const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' }) as Buffer;
  const buf = Buffer.from(pptxBuffer);

  // A .pptx is a ZIP; every valid one starts 'PK'. Catching it here turns a
  // corrupt download into an error at the point it was produced.
  if (buf.length < 1000 || buf.subarray(0, 2).toString() !== 'PK') {
    throw new Error(`Generated ${buf.length} bytes that are not a valid .pptx.`);
  }

  return { pptx: buf, bytes: buf.length, slideCount: slides.length + 1 };
}
