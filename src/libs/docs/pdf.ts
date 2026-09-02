/**
 * PDF generation — a document SPEC in, a real .pdf out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO RENDERERS, ONE DOCUMENT
 *
 * A PDF is a picture of a finished page, so HTML + Chrome is the right tool:
 * real typography, real tables, webfonts, brand colours. That is the primary
 * path and it reuses the AgentCore browser session the platform already pays
 * for — no Chromium in the Railway image, no per-document API bill.
 *
 * But it depends on a browser we do not control executing `Page.printToPDF`,
 * and "the client's proposal failed to render" is not an acceptable outcome of
 * an open question about AWS. So every document is ALSO renderable by
 * `renderFallbackPdf` (pure JS, pdf-lib, no browser, cannot fail for
 * environmental reasons). Both consume the same block IR from markdown.ts, so
 * the fallback produces the same DOCUMENT — plainer, but the same headings,
 * the same tables, the same order — rather than a different-looking apology.
 *
 * The result says which engine ran. That matters: if every PDF in production
 * comes back `engine: 'fallback'`, printToPDF is blocked and somebody should
 * know, rather than quietly shipping second-best output forever.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE AGENT DOES NOT WRITE THE CSS
 *
 * Same reason it does not write slide coordinates in pptx.ts: given a blank
 * canvas it invents layout, and invented layout reads as a rendering bug. The
 * agent supplies markdown; the shell below owns every measurement. `html` is
 * available as an escape hatch for the genuinely bespoke case (an invoice with
 * a fixed template), and it is the ONE input the fallback cannot rescue —
 * stated plainly in the tool description rather than discovered at 2am.
 */

import type { Buffer } from 'node:buffer';
import type { DocBlock } from '@/libs/docs/markdown';
import { browserConfigured, renderPdf } from '@/libs/browser/agentcore';
import { inlineHtml, parseMarkdown } from '@/libs/docs/markdown';
import { renderFallbackPdf } from '@/libs/docs/pdfFallback';

export type PdfTheme = {
  /** Hex, with or without '#'. Headings, rules and table headers. */
  accent?: string;
  text?: string;
  muted?: string;
  /** Page background. Print documents are white unless someone insists. */
  background?: string;
  fontFace?: string;
  /** Public image URL, drawn small at the top of the first page. */
  logoUrl?: string;
};

export type DocumentSpec = {
  title: string;
  subtitle?: string;
  /** The document body. Markdown, as the agent writes it. */
  markdown?: string;
  /** Escape hatch: complete hand-authored HTML. Chrome path only. */
  html?: string;
  theme?: PdfTheme;
  /** Small line repeated at the bottom of every page, beside the page number. */
  footer?: string;
  pageSize?: 'letter' | 'a4';
  landscape?: boolean;
};

export type DocumentResult = {
  pdf: Buffer;
  bytes: number;
  engine: 'chrome' | 'fallback';
  /** Set when the fallback ran: why the browser path did not. */
  note?: string;
};

const PAGE_SIZES = {
  letter: {
    width: 8.5,
    height: 11,
  },
  a4: {
    width: 8.27,
    height: 11.69,
  },
};

const DEFAULT_THEME = {
  accent: '#0F62FE',
  text: '#111827',
  muted: '#6B7280',
  background: '#FFFFFF',
  fontFace: 'Inter',
};

/**
 * Normalise a colour to '#RRGGBB'.
 *
 * The mirror image of pptx.ts's `hex()`, and here for the same reason: every
 * model writes colours in whichever form it saw last. CSS needs the '#';
 * pptxgenjs forbids it. Both files normalise at their own boundary rather than
 * trusting the caller to know which world it is in.
 */
export function cssColor(value: string | undefined, fallback: string): string {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(raw)) {
    return `#${raw.toUpperCase()}`;
  }
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw.split('').map(c => c + c).join('').toUpperCase()}`;
  }
  return fallback;
}

function escapeAttr(value: string): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function blockHtml(block: DocBlock): string {
  switch (block.type) {
    case 'heading':
      return `<h${block.level}>${inlineHtml(block.text)}</h${block.level}>`;
    case 'paragraph':
      return `<p>${inlineHtml(block.text)}</p>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map(item => `<li>${inlineHtml(item)}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    }
    case 'table': {
      const head = block.headers.length
        ? `<thead><tr>${block.headers.map(h => `<th>${inlineHtml(h)}</th>`).join('')}</tr></thead>`
        : '';
      const body = block.rows
        .map(row => `<tr>${row.map(cell => `<td>${inlineHtml(cell)}</td>`).join('')}</tr>`)
        .join('');
      return `<table>${head}<tbody>${body}</tbody></table>`;
    }
    case 'quote':
      return `<blockquote>${inlineHtml(block.text)}</blockquote>`;
    case 'code':
      return `<pre>${inlineHtml(block.text).replace(/<\/?(?:code|strong|em|a)[^>]*>/g, '')}</pre>`;
    case 'image':
      return `<figure><img src="${escapeAttr(block.url)}" alt="${escapeAttr(block.alt)}"></figure>`;
    case 'divider':
      return '<hr>';
    case 'pagebreak':
      return '<div class="pagebreak"></div>';
    default:
      return '';
  }
}

/**
 * The document shell.
 *
 * `print-color-adjust: exact` is not optional: without it Chrome drops every
 * background colour when printing, so an accent-barred heading and a striped
 * table come out as bare text and the document looks unstyled rather than
 * broken — which is much harder to notice in review.
 *
 * `break-inside: avoid` on tables, figures and headings is the difference
 * between a professional document and one where a heading sits alone at the
 * foot of a page with its paragraph overleaf.
 */
export function buildDocumentHtml(spec: DocumentSpec, blocks: DocBlock[]): string {
  const theme = spec.theme ?? {};
  const accent = cssColor(theme.accent, DEFAULT_THEME.accent);
  const text = cssColor(theme.text, DEFAULT_THEME.text);
  const muted = cssColor(theme.muted, DEFAULT_THEME.muted);
  const background = cssColor(theme.background, DEFAULT_THEME.background);
  const font = String(theme.fontFace ?? DEFAULT_THEME.fontFace).replace(/["'<>]/g, '').slice(0, 60);
  const size = PAGE_SIZES[spec.pageSize === 'a4' ? 'a4' : 'letter'];
  const width = spec.landscape ? size.height : size.width;
  const height = spec.landscape ? size.width : size.height;

  const logo = theme.logoUrl
    ? `<img class="logo" src="${escapeAttr(theme.logoUrl)}" alt="">`
    : '';
  const subtitle = spec.subtitle
    ? `<p class="doc-subtitle">${inlineHtml(spec.subtitle)}</p>`
    : '';

  return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  @page { size: ${width}in ${height}in; margin: 0.75in 0.7in 0.6in }
  * { margin: 0; padding: 0; box-sizing: border-box }
  html, body {
    background: ${background};
    color: ${text};
    font-family: '${font}', -apple-system, 'Segoe UI', system-ui, sans-serif;
    font-size: 10.5pt;
    line-height: 1.55;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .logo { max-height: 44px; max-width: 200px; margin-bottom: 20px }
  h1.doc-title { font-size: 23pt; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15 }
  .doc-subtitle { color: ${muted}; font-size: 12pt; margin-top: 6px }
  .doc-rule { border: 0; border-top: 3px solid ${accent}; margin: 14px 0 26px; width: 68px }
  h1, h2, h3 { break-after: avoid; page-break-after: avoid }
  h1 { font-size: 17pt; font-weight: 700; margin: 26px 0 8px; letter-spacing: -0.01em }
  h2 { font-size: 13.5pt; font-weight: 700; margin: 22px 0 6px; color: ${accent} }
  h3 { font-size: 11.5pt; font-weight: 600; margin: 18px 0 4px }
  p { margin: 0 0 10px }
  ul, ol { margin: 0 0 12px 20px }
  li { margin-bottom: 5px }
  li::marker { color: ${accent} }
  a { color: ${accent}; text-decoration: none }
  strong { font-weight: 700 }
  code { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 9.5pt; background: #F3F4F6; padding: 1px 4px; border-radius: 3px }
  pre {
    font-family: 'SFMono-Regular', Consolas, monospace; font-size: 9pt; line-height: 1.45;
    background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 6px;
    padding: 12px 14px; margin: 0 0 14px; white-space: pre-wrap; word-break: break-word;
  }
  blockquote {
    border-left: 3px solid ${accent}; padding: 4px 0 4px 14px; margin: 0 0 14px;
    color: ${muted}; font-style: italic; break-inside: avoid;
  }
  table { width: 100%; border-collapse: collapse; margin: 0 0 16px; font-size: 9.5pt; break-inside: auto }
  thead { display: table-header-group }
  tr { break-inside: avoid; page-break-inside: avoid }
  th {
    text-align: left; font-weight: 700; color: #FFFFFF; background: ${accent};
    padding: 7px 10px; border: 1px solid ${accent};
  }
  td { padding: 6px 10px; border: 1px solid #E5E7EB; vertical-align: top }
  tbody tr:nth-child(even) td { background: #F9FAFB }
  figure { margin: 0 0 16px; break-inside: avoid }
  img { max-width: 100%; height: auto }
  hr { border: 0; border-top: 1px solid #E5E7EB; margin: 20px 0 }
  .pagebreak { break-after: page; page-break-after: always; height: 0 }
</style></head>
<body>
  ${logo}
  <h1 class="doc-title">${inlineHtml(spec.title)}</h1>
  ${subtitle}
  <hr class="doc-rule">
  ${blocks.map(blockHtml).join('\n  ')}
</body></html>`;
}

/**
 * Chrome's footer template lives outside the page's own stylesheet — external
 * CSS does not reach it and its default font-size is ~8px, so everything it
 * needs must be inline. `pageNumber`/`totalPages` are class names Chrome fills
 * in itself; they are not our variables and must not be renamed.
 */
function footerTemplate(footer: string | undefined, muted: string): string {
  const label = escapeAttr(String(footer ?? '').slice(0, 160));
  return `<div style="width:100%;font-size:8px;color:${muted};padding:0 0.7in;display:flex;justify-content:space-between;font-family:sans-serif">
    <span>${label}</span>
    <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
  </div>`;
}

export async function renderDocument(spec: DocumentSpec): Promise<DocumentResult> {
  if (!spec?.title || !String(spec.title).trim()) {
    throw new Error('The document needs a title.');
  }
  const hasHtml = Boolean(spec.html && String(spec.html).trim());
  const blocks = hasHtml ? [] : parseMarkdown(spec.markdown ?? '');
  if (!hasHtml && blocks.length === 0) {
    throw new Error('The document is empty — pass `markdown` with the body content (or `html` for a hand-built layout).');
  }

  const size = PAGE_SIZES[spec.pageSize === 'a4' ? 'a4' : 'letter'];
  const muted = cssColor(spec.theme?.muted, DEFAULT_THEME.muted);
  const html = hasHtml ? String(spec.html) : buildDocumentHtml(spec, blocks);

  let browserError: string | null = null;

  if (browserConfigured()) {
    try {
      const result = await renderPdf({
        html,
        landscape: Boolean(spec.landscape),
        paperWidthIn: size.width,
        paperHeightIn: size.height,
        marginIn: 0.7,
        // The shell declares its own @page size; letting it win is what keeps
        // an A4 document A4 instead of silently cropped to Letter.
        preferCssPageSize: true,
        media: 'screen',
        // Webfont + any remote logo/images have to have landed before the
        // print, and setDocumentContent resolves on parse, not on load.
        waitMs: 2600,
        footerHtml: footerTemplate(spec.footer, muted),
      });
      return {
        pdf: result.pdf,
        bytes: result.bytes,
        engine: 'chrome',
      };
    } catch (err) {
      browserError = err instanceof Error ? err.message : 'unknown browser error';
    }
  } else {
    browserError = 'the AgentCore browser is not configured in this environment';
  }

  if (hasHtml) {
    // Honest dead end. The fallback lays out blocks, and hand-written HTML is
    // not blocks — pretending otherwise would return a document that is not the
    // one that was asked for, which is worse than an error that says what to do.
    throw new Error(
      `Could not render the hand-authored HTML to PDF (${browserError}). `
      + 'The browser-free fallback renderer cannot lay out arbitrary HTML. '
      + 'Retry with `markdown` instead of `html` and it will render.',
    );
  }

  const fallback = await renderFallbackPdf(spec, blocks);
  return {
    pdf: fallback.pdf,
    bytes: fallback.bytes,
    engine: 'fallback',
    note: `Rendered without the browser (${browserError}). Layout is plainer than the styled renderer, but the content is complete.`,
  };
}
