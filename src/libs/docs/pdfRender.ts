/**
 * Rasterise PDF pages — the whole page, text and vectors included.
 *
 * Why this exists next to pdfImages.ts: a Canva/Word export of a picture
 * book is NOT "one image per page". It is an image PLUS live text (page
 * titles, captions, frames, decorations) laid over it. Extracting embedded
 * images silently throws the text away — Mia's Cozy Bear book lost every
 * caption ("Good morning!", "Gardening time") that way. Rendering the page
 * keeps what the designer saw, at whatever dpi the book needs.
 *
 * pdf.js (via unpdf) + @napi-rs/canvas — both already dependencies of the
 * book publisher. Pure in-process; ~1 s per page at 2550 px.
 */

import { getDocumentProxy, renderPageAsImage } from 'unpdf';

export type RenderedPage = {
  page: number; // 1-based
  png: Buffer;
  width: number;
  height: number;
};

export const MAX_RENDER_PAGES = 400;

/**
 * Render every page (or `pages`) so that its LONGER side is `targetPx`
 * pixels. Pages are rendered one at a time to keep memory flat; a 400-page
 * book is 400 sequential renders, not 400 canvases at once.
 */
export async function renderPdfPages(bytes: Buffer, opts: { targetPx: number; pages?: number[]; max?: number }): Promise<{ pages: RenderedPage[]; pageCount: number; skipped: Array<{ page: number; reason: string }> }> {
  const data = new Uint8Array(bytes);
  const doc = await getDocumentProxy(data);
  const pageCount = doc.numPages;
  const wanted = (opts.pages?.length ? opts.pages : Array.from({ length: pageCount }, (_, i) => i + 1))
    .filter(n => n >= 1 && n <= pageCount)
    .slice(0, opts.max ?? MAX_RENDER_PAGES);
  const out: RenderedPage[] = [];
  const skipped: Array<{ page: number; reason: string }> = [];

  for (const n of wanted) {
    try {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const scale = opts.targetPx / Math.max(vp.width, vp.height);
      // Pass the proxy, not the bytes: pdf.js TRANSFERS (detaches) a buffer
      // it is handed, so re-using `data` after getDocumentProxy throws
      // "Cannot transfer object of unsupported type".
      const png = Buffer.from(await renderPageAsImage(doc, n, {
        canvasImport: () => import('@napi-rs/canvas'),
        scale,
      }));
      out.push({ page: n, png, width: Math.round(vp.width * scale), height: Math.round(vp.height * scale) });
    } catch (err) {
      skipped.push({ page: n, reason: err instanceof Error ? err.message.slice(0, 200) : 'render failed' });
    }
  }
  return { pages: out, pageCount, skipped };
}
