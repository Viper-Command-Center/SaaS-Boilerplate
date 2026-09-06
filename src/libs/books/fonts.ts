/**
 * Fonts embedded in book PDFs. KDP requires every font to be EMBEDDED;
 * pdf-lib's Standard-14 fonts are referenced, not embedded, and (worse) are
 * WinAnsi-only, so a title with a curly quote or an em dash throws. These two
 * OFL families ship in public/fonts and are embedded as subsets via fontkit.
 *
 * `display` = Fredoka (rounded, friendly — right for children's and activity
 * books). `body` = Nunito. Both are Google Fonts static instances; see
 * public/fonts/LICENSE.txt.
 */

import type { PDFDocument, PDFFont } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { StandardFonts } from 'pdf-lib';

export type FontRole = 'display' | 'displayBold' | 'body' | 'bodyBold';

const FILES: Record<FontRole, string> = {
  display: 'Fredoka-SemiBold.ttf',
  displayBold: 'Fredoka-Bold.ttf',
  body: 'Nunito-Regular.ttf',
  bodyBold: 'Nunito-Bold.ttf',
};

const cache = new Map<FontRole, Promise<Buffer | null>>();

function fontBytes(role: FontRole): Promise<Buffer | null> {
  let p = cache.get(role);
  if (!p) {
    p = readFile(path.join(process.cwd(), 'public', 'fonts', FILES[role])).catch(() => null);
    cache.set(role, p);
  }
  return p;
}

export type BookFonts = Record<FontRole, PDFFont> & { embedded: boolean };

/**
 * Embed the four faces into `doc`. Falls back to Helvetica if the files are
 * missing (a broken deploy, not a normal state) — the PDF still renders, and
 * `embedded: false` is reported so preflight can warn instead of KDP rejecting.
 */
export async function embedBookFonts(doc: PDFDocument): Promise<BookFonts> {
  doc.registerFontkit(fontkit);
  const roles: FontRole[] = ['display', 'displayBold', 'body', 'bodyBold'];
  const bytes = await Promise.all(roles.map(fontBytes));
  const allPresent = bytes.every(Boolean);

  if (allPresent) {
    const [display, displayBold, body, bodyBold] = await Promise.all(
      bytes.map(b => doc.embedFont(b as Buffer, { subset: true })),
    );
    return { display: display!, displayBold: displayBold!, body: body!, bodyBold: bodyBold!, embedded: true };
  }

  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvB = await doc.embedFont(StandardFonts.HelveticaBold);
  return { display: helvB, displayBold: helvB, body: helv, bodyBold: helvB, embedded: false };
}

/**
 * Strip characters a font cannot encode instead of throwing mid-render.
 * Real fonts cover far more than WinAnsi, so this rarely does anything; it
 * exists so a stray emoji in a subtitle never fails a cover build.
 */
export function safeText(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      // drop
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Greedy word wrap to a width, in the given font/size. */
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of safeText(font, text).split(/\n+/)) {
    const words = para.split(' ').filter(Boolean);
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) {
        line = next;
      } else {
        lines.push(line);
        line = w;
      }
    }
    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

/** Largest size (≤ max) at which `text` wraps into ≤ maxLines within maxWidth. */
export function fitFontSize(font: PDFFont, text: string, a: { maxWidth: number; maxLines: number; max: number; min: number }): number {
  for (let size = a.max; size >= a.min; size -= 2) {
    if (wrapText(font, text, size, a.maxWidth).length <= a.maxLines) {
      return size;
    }
  }
  return a.min;
}
