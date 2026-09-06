/**
 * Book publisher tools — the agent's end-to-end path from "a folder of
 * pictures" to "two PDFs I upload to KDP". Platform tools (free, every
 * workspace, policy 'auto'): nothing here leaves the tenant's own storage.
 *
 * The shape, and why:
 *  - A BOOK is a row (books table) holding page ORDER and settings; the page
 *    images are ordinary library files. Deleting a book never deletes art.
 *  - KDP's rules (trim, bleed, margins, gutter, page counts, spine, barcode)
 *    live in src/libs/books/kdp.ts and are applied by BOTH preflight and the
 *    renderers, so a book that passes preflight renders compliant.
 *  - Coloring pages are thresholded to pure black/white at import and again
 *    at render (lineArt.ts) — the difference between "AI coloring book" and
 *    a professional one on a black-ink press.
 *  - Amazon has NO publishing API. The output is a packet: interior PDF,
 *    cover PDF, listing sheet, and a checklist. A human uploads it; that is
 *    the last mile and it stays human on purpose (KDP's terms forbid
 *    automated access and an account ban ends the business).
 */

import type { PlatformExecutor } from './platformTools';
import type { InteriorPage } from '@/libs/books/interior';
import type { InkType, PaperType, PreflightIssue, PreflightPage } from '@/libs/books/kdp';
import type { Book, BookCover, BookKind, BookListing, BookPage } from '@/libs/books/store';
import type { AnthropicTool } from '@/libs/mcp/registry';
import { renderCover } from '@/libs/books/cover';
import { expandPages, renderInterior } from '@/libs/books/interior';
import { coverGeometry, hasErrors, interiorPageIn, inToPx, pageLimits, parseTrim, preflight, TRIM_SIZES } from '@/libs/books/kdp';
import { imageSize, prepareLineArt } from '@/libs/books/lineArt';
import { createBook, deleteBook, listBooks, resolveBook, updateBook } from '@/libs/books/store';
import { extractPdfImages } from '@/libs/docs/pdfImages';
import { isPdf } from '@/libs/docs/pdfText';
import { getFile, saveFile } from '@/libs/storage/files';
import { getObject } from '@/libs/storage/r2';

const MAX_PAGES = 400;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/tiff', 'image/bmp']);

const PAGE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['art', 'text', 'blank'], description: 'art = an image file; text = a simple centred text page (title page, copyright, "This book belongs to"); blank = empty page.' },
    fileId: { type: 'string', description: 'art only: library file id of the image.' },
    heading: { type: 'string', description: 'text only.' },
    lines: { type: 'array', items: { type: 'string' }, description: 'text only: body lines, centred. Empty string = blank line.' },
    label: { type: 'string', description: 'Optional note shown in get_book, e.g. "cat with hat".' },
  },
  required: ['kind'],
};

export function buildBookTools(tenantId: string): {
  anthropicTools: AnthropicTool[];
  executors: Map<string, PlatformExecutor>;
} {
  const executors = new Map<string, PlatformExecutor>();

  const anthropicTools: AnthropicTool[] = [
    {
      name: 'list_books',
      description: 'List the book projects in this workspace (id, title, kind, trim, page count, status, last preflight). A book is an ORDERED LIST of page images plus print settings; the images themselves are ordinary files in the library.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'create_book',
      description: `Start a print book project for Amazon KDP (paperback). Ask the user for the trim size if they have not said — it cannot be changed cheaply once art is made for it. Standard KDP trims: ${TRIM_SIZES.map(t => t.label).join(', ')}. Coloring books are usually 8.5x11 or 8.5x8.5, black ink, white paper, NO bleed (art inside a white margin), single-sided (blank behind every page so markers do not bleed through). Use bleed:true only when art must run off the page edge — the art then needs 0.125in extra on top/bottom/outside and KDP crops it.`,
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          author: { type: 'string', description: 'Name printed on the cover and used in the KDP listing.' },
          kind: { type: 'string', enum: ['coloring', 'illustrated', 'text'], description: 'coloring = pages are thresholded to pure black/white line art. illustrated = full-colour/toned pages kept as-is. text = typeset pages (title/copyright/notes only for now).' },
          trimSize: { type: 'string', description: 'e.g. "8.5x8.5", "8.5x11", "6x9", "a4". Inches.' },
          bleed: { type: 'boolean', description: 'Default false for coloring, true for illustrated.' },
          paper: { type: 'string', enum: ['white', 'cream'], description: 'Default white. Cream is for novels; colour ink requires white.' },
          ink: { type: 'string', enum: ['black', 'color-standard', 'color-premium'], description: 'Default black (coloring books). Colour ink raises the print cost a lot.' },
          singleSided: { type: 'boolean', description: 'Blank page behind every art page. Default true for coloring, false otherwise.' },
        },
        required: ['title', 'trimSize'],
      },
    },
    {
      name: 'get_book',
      description: 'Full state of one book: settings, every page in order (with image URLs you can look at), cover settings, listing metadata, output files, and a fresh KDP preflight. Call this before changing pages so you work from the current order.',
      input_schema: {
        type: 'object',
        properties: { book: { type: 'string', description: 'Book id or exact title.' } },
        required: ['book'],
      },
    },
    {
      name: 'update_book',
      description: 'Change a book\'s settings, KDP listing metadata, or cover settings. Only the fields you pass change; listing and cover objects MERGE with what is stored. Listing fields are what the user types into KDP: description (up to 4000 chars, HTML-free), 7 keywords, up to 3 categories, price, age range. Write the description and keywords for them when they ask — that is the part most self-publishers get wrong.',
      input_schema: {
        type: 'object',
        properties: {
          book: { type: 'string', description: 'Book id or exact title.' },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          author: { type: 'string' },
          kind: { type: 'string', enum: ['coloring', 'illustrated', 'text'] },
          trimSize: { type: 'string' },
          bleed: { type: 'boolean' },
          paper: { type: 'string', enum: ['white', 'cream'] },
          ink: { type: 'string', enum: ['black', 'color-standard', 'color-premium'] },
          singleSided: { type: 'boolean' },
          status: { type: 'string', enum: ['draft', 'ready', 'published'], description: 'Set published after the user confirms KDP accepted it.' },
          listing: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              keywords: { type: 'array', items: { type: 'string' }, description: 'Up to 7 KDP keyword phrases.' },
              categories: { type: 'array', items: { type: 'string' }, description: 'Up to 3, e.g. "Juvenile Nonfiction > Activity Books > Coloring".' },
              priceUsd: { type: 'number' },
              language: { type: 'string' },
              ageRange: { type: 'string', description: 'e.g. "4-8"' },
            },
          },
          cover: {
            type: 'object',
            description: 'Same fields as build_book_cover; stored for the next build.',
            properties: {
              frontArtFileId: { type: 'string' },
              backArtFileId: { type: 'string' },
              blurb: { type: 'string' },
              background: { type: 'string' },
              spineColor: { type: 'string' },
              textColor: { type: 'string' },
              spineText: { type: 'boolean' },
              titlePosition: { type: 'string', enum: ['top', 'bottom'] },
              titleBand: { type: 'boolean' },
              backFooter: { type: 'string' },
            },
          },
        },
        required: ['book'],
      },
    },
    {
      name: 'set_book_pages',
      description: 'Set or extend the ORDERED page list. mode "replace" sets the whole list (this is how you reorder: pass every page in the new order); "append" adds to the end; "insert" adds before position `at` (1-based). Pages are LOGICAL — do not add blanks for single-sided printing, the renderer does that. Art pages take a library file id (from generate_image, import_book_pages, prepare_line_art, or an upload). Typical opening: a text page {kind:"text", heading:"<title>", lines:["<author>"]}, a text page with copyright, then the art.',
      input_schema: {
        type: 'object',
        properties: {
          book: { type: 'string' },
          mode: { type: 'string', enum: ['replace', 'append', 'insert'] },
          at: { type: 'number', description: 'insert only: 1-based position the new pages go before.' },
          pages: { type: 'array', items: PAGE_SCHEMA },
        },
        required: ['book', 'mode', 'pages'],
      },
    },
    {
      name: 'remove_book_pages',
      description: 'Remove pages by 1-based position (as shown by get_book). The image files stay in the library.',
      input_schema: {
        type: 'object',
        properties: {
          book: { type: 'string' },
          positions: { type: 'array', items: { type: 'number' } },
        },
        required: ['book', 'positions'],
      },
    },
    {
      name: 'import_book_pages',
      description: 'Bring existing artwork into a book from the library: a PDF (e.g. exported from Canva/Procreate — every page image is pulled out in order), or image files. For coloring books each page is cleaned to pure black/white line art automatically (set prepare:false to keep it untouched). Appends to the book in order and returns the new page files. This is how a book started elsewhere moves into the workspace: the user uploads the PDF on the Files page, then you call this.',
      input_schema: {
        type: 'object',
        properties: {
          book: { type: 'string' },
          fileIds: { type: 'array', items: { type: 'string' }, description: 'Library ids of PDFs and/or images, in the order they should appear.' },
          prepare: { type: 'boolean', description: 'Run line-art cleanup (default: true for coloring books, false otherwise).' },
          threshold: { type: 'number', description: 'Line-art cut 1–254 (default 160). Raise it if faint lines vanish, lower it if grey shading survives.' },
        },
        required: ['book', 'fileIds'],
      },
    },
    {
      name: 'prepare_line_art',
      description: 'Clean images into print-grade coloring-page line art: flatten to white, remove grey shading and speckles, force pure black/white, optionally thicken thin lines. Saves NEW files (originals untouched) and returns their ids plus ink coverage (0.02–0.25 is a normal page; near 0 means the lines were lost — raise threshold; above 0.4 means shading survived — lower it). Pass `book` to swap the cleaned files into that book\'s pages in place. Use this on generate_image output before it goes into a coloring book.',
      input_schema: {
        type: 'object',
        properties: {
          fileIds: { type: 'array', items: { type: 'string' } },
          threshold: { type: 'number', description: '1–254, default 160.' },
          despeckle: { type: 'number', description: '0–3, default 1. Higher removes bigger specks but can eat fine detail.' },
          thicken: { type: 'number', description: '0–4 px, default 0. 1–2 rescues hairline AI output.' },
          book: { type: 'string', description: 'Optional: replace these files in this book\'s page list with the cleaned versions.' },
        },
        required: ['fileIds'],
      },
    },
    {
      name: 'preflight_book',
      description: 'Check a book against KDP\'s paperback rules WITHOUT rendering: page-count limits per ink/paper, trim size, bleed geometry, 300-dpi resolution of every page for the box it fills, aspect mismatches, cover art present, spine-text eligibility. Errors will get the upload rejected or the book printed wrong; fix them before build_kdp_package. Warnings are judgement calls — tell the user.',
      input_schema: {
        type: 'object',
        properties: { book: { type: 'string' } },
        required: ['book'],
      },
    },
    {
      name: 'build_book_interior',
      description: 'Render the interior (manuscript) PDF exactly to KDP spec: page box = trim (+0.125in bleed on top/bottom/outside when bleed is on), art resampled to 300 dpi, gutter margin by page count on the spine side, blank backs for single-sided books, even page count. Runs preflight first and refuses on errors unless force:true. Saves the PDF to the library (private) and returns its id and page count. Interior page count decides the spine width, so build this BEFORE the cover.',
      input_schema: {
        type: 'object',
        properties: {
          book: { type: 'string' },
          force: { type: 'boolean', description: 'Render despite preflight errors (for a proof, never for upload).' },
        },
        required: ['book'],
      },
    },
    {
      name: 'build_book_cover',
      description: 'Render the full-wrap paperback cover (back + spine + front, one PDF at KDP\'s exact size for this trim and page count) and a PNG preview you and the user can look at. Front art fills the front (generate it with generate_image at a square-ish or portrait ratio, then pass its file id); the title, subtitle and author are typeset over it; the back gets the blurb; the barcode zone is kept white as KDP requires; spine text only when the book has 79+ pages. Fields you pass are saved to the book so a rebuild after a page-count change is one call. Look at the preview before telling the user it is done.',
      input_schema: {
        type: 'object',
        properties: {
          book: { type: 'string' },
          frontArtFileId: { type: 'string', description: 'Library id of the front cover art.' },
          backArtFileId: { type: 'string', description: 'Optional back cover art (a pattern or a sample page works well).' },
          blurb: { type: 'string', description: 'Back-cover text, 2–5 short sentences.' },
          background: { type: 'string', description: 'Hex, e.g. "#FFD447". Fills everything the art does not.' },
          spineColor: { type: 'string', description: 'Hex; defaults to background.' },
          textColor: { type: 'string', description: 'Hex; default near-black.' },
          spineText: { type: 'boolean', description: 'Title + author on the spine (needs 79+ pages).' },
          titlePosition: { type: 'string', enum: ['top', 'bottom'] },
          titleBand: { type: 'boolean', description: 'Translucent band behind the title for legibility over busy art. Default on when art is present.' },
          backFooter: { type: 'string', description: 'Small line bottom-left of the back, e.g. a website.' },
        },
        required: ['book'],
      },
    },
    {
      name: 'build_kdp_package',
      description: 'The finish line: preflight → interior PDF → cover PDF (spine sized from the real page count) → listing sheet (title, subtitle, author, description, keywords, categories, trim, bleed, paper, ink, page count, price) → upload checklist. Returns every file id. Amazon has no publishing API, so the user uploads these on kdp.amazon.com — walk them through the checklist. Refuses on preflight errors.',
      input_schema: {
        type: 'object',
        properties: { book: { type: 'string' } },
        required: ['book'],
      },
    },
    {
      name: 'delete_book',
      description: 'Delete a book project. Its page images and built PDFs stay in the library. Confirm with the user first.',
      input_schema: {
        type: 'object',
        properties: { book: { type: 'string' } },
        required: ['book'],
      },
    },
  ];

  // ── helpers ──────────────────────────────────────────────────────────────

  const loadBytes = async (fileId: string) => {
    const row = await getFile(tenantId, fileId);
    if (!row) {
      throw new Error(`No file with id "${fileId}" in this workspace — call list_files for current ids.`);
    }
    const { body } = await getObject(row.r2Key);
    return { row, bytes: body };
  };

  const isImage = (name: string, mime: string | null) => (mime && IMAGE_MIMES.has(mime)) || /\.(?:png|jpe?g|webp|gif|tiff?|bmp)$/i.test(name);

  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'book';

  /** Resolve page files → bytes + pixel sizes; used by preflight and the renderer. */
  const loadPages = async (book: Book, withBytes: boolean) => {
    const out: Array<{ page: BookPage; bytes?: Buffer; width?: number; height?: number; name?: string; url?: string | null; missing?: boolean }> = [];
    for (const page of book.pages) {
      if (page.kind !== 'art') {
        out.push({ page });
        continue;
      }
      const row = await getFile(tenantId, page.fileId);
      if (!row) {
        out.push({ page, missing: true });
        continue;
      }
      const meta = (row.meta ?? {}) as { width?: number; height?: number };
      let width = meta.width;
      let height = meta.height;
      let bytes: Buffer | undefined;
      if (withBytes || !width || !height) {
        bytes = (await getObject(row.r2Key)).body;
        if (!width || !height) {
          const s = await imageSize(bytes);
          width = s?.width;
          height = s?.height;
        }
      }
      out.push({ page, bytes: withBytes ? bytes : undefined, width, height, name: row.name, url: row.publicUrl });
    }
    return out;
  };

  const runPreflight = async (book: Book) => {
    const loaded = await loadPages(book, false);
    const missing = loaded.filter(l => l.missing).map((_, i) => i + 1);
    const logical: PreflightPage[] = loaded.map(l => ({ kind: l.page.kind, widthPx: l.width, heightPx: l.height }));
    // preflight sees PHYSICAL pages, as KDP counts them
    const physical: PreflightPage[] = [];
    for (const p of logical) {
      physical.push(p);
      if (book.singleSided && p.kind === 'art') {
        physical.push({ kind: 'blank' });
      }
    }
    if (physical.length % 2 === 1) {
      physical.push({ kind: 'blank' });
    }
    const issues = preflight({
      trim: book.trim,
      bleed: book.bleed,
      paper: book.paper,
      ink: book.ink,
      pages: physical,
      hasCoverArt: Boolean(book.cover.frontArtFileId),
      title: book.title,
      spineText: book.cover.spineText ? book.title : undefined,
    });
    for (const m of missing) {
      issues.unshift({ level: 'error', code: 'missing-file', page: m, message: `Page ${m} points at a file that no longer exists in the library.` });
    }
    if (book.pages.length === 0) {
      issues.unshift({ level: 'error', code: 'no-pages', message: 'The book has no pages yet — add art with set_book_pages / import_book_pages.' });
    }
    return { issues, physicalCount: physical.length, logicalCount: logical.length, loaded };
  };

  const summarise = (issues: PreflightIssue[]) => ({
    ok: !hasErrors(issues),
    errors: issues.filter(i => i.level === 'error').length,
    warnings: issues.filter(i => i.level === 'warning').length,
    issues,
  });

  const bookView = (b: Book) => ({
    id: b.id,
    title: b.title,
    subtitle: b.subtitle,
    author: b.author,
    kind: b.kind,
    trim: b.trim.label,
    bleed: b.bleed,
    paper: b.paper,
    ink: b.ink,
    singleSided: b.singleSided,
    logicalPages: b.pages.length,
    status: b.status,
    interiorFileId: b.interiorFileId,
    coverFileId: b.coverFileId,
    coverPreviewFileId: b.coverPreviewFileId,
    updatedAt: b.updatedAt,
  });

  const parsePages = (raw: unknown): BookPage[] => {
    if (!Array.isArray(raw)) {
      throw new TypeError('`pages` must be an array of { kind, fileId | heading/lines }.');
    }
    return raw.map((p, i) => {
      const o = (p ?? {}) as Record<string, unknown>;
      const kind = String(o.kind ?? 'art');
      if (kind === 'art') {
        const fileId = String(o.fileId ?? '').trim();
        if (!fileId) {
          throw new Error(`pages[${i}] is an art page with no fileId.`);
        }
        return { kind: 'art', fileId, ...(o.label ? { label: String(o.label).slice(0, 120) } : {}) } satisfies BookPage;
      }
      if (kind === 'text') {
        return {
          kind: 'text',
          ...(o.heading ? { heading: String(o.heading).slice(0, 300) } : {}),
          ...(Array.isArray(o.lines) ? { lines: o.lines.map(l => String(l).slice(0, 500)).slice(0, 60) } : {}),
          ...(o.label ? { label: String(o.label).slice(0, 120) } : {}),
        } satisfies BookPage;
      }
      if (kind === 'blank') {
        return { kind: 'blank' } satisfies BookPage;
      }
      throw new Error(`pages[${i}].kind must be art, text or blank.`);
    });
  };

  const renderInteriorFor = async (book: Book, opts: { force?: boolean }) => {
    const pre = await runPreflight(book);
    if (hasErrors(pre.issues) && !opts.force) {
      throw new Error(`Preflight failed — fix these before building (or pass force:true for a proof):\n${pre.issues.filter(i => i.level === 'error').map(i => `- ${i.message}`).join('\n')}`);
    }
    const loaded = await loadPages(book, true);
    const logical: InteriorPage[] = loaded.map(l =>
      l.page.kind === 'art'
        ? { kind: 'art', bytes: l.bytes ?? Buffer.alloc(0), label: l.page.label }
        : l.page.kind === 'text'
          ? { kind: 'text', heading: l.page.heading, lines: l.page.lines, label: l.page.label }
          : { kind: 'blank' },
    );
    const physical = expandPages(logical, { singleSided: book.singleSided, padToEven: true });
    const result = await renderInterior({
      trim: book.trim,
      bleed: book.bleed,
      paper: book.paper,
      ink: book.ink,
      pages: physical,
      lineArt: book.kind === 'coloring',
      title: book.title,
    });
    const file = await saveFile({
      tenantId,
      name: `${slug(book.title)}-interior.pdf`,
      bytes: result.pdf,
      mime: 'application/pdf',
      kind: 'knowledge', // print files are the product — private, like a client deck
      source: 'agent',
      meta: { bookId: book.id, role: 'interior', pageCount: result.pageCount, trim: book.trim.label, bleed: book.bleed },
    });
    await updateBook(tenantId, book.id, { interiorFileId: file?.id ?? null, lastPreflight: summarise(pre.issues) });
    return { file, result, pre };
  };

  const renderCoverFor = async (book: Book, pageCount: number) => {
    const c = book.cover;
    if (!c.frontArtFileId) {
      throw new Error('No front cover art. Generate one (generate_image) or pick an upload, then pass its id as frontArtFileId.');
    }
    const front = (await loadBytes(c.frontArtFileId)).bytes;
    const back = c.backArtFileId ? (await loadBytes(c.backArtFileId)).bytes : null;
    const r = await renderCover({
      trim: book.trim,
      pageCount,
      paper: book.paper,
      ink: book.ink,
      title: book.title,
      subtitle: book.subtitle ?? undefined,
      author: book.author ?? undefined,
      blurb: c.blurb,
      spineText: c.spineText,
      frontArt: front,
      backArt: back,
      background: c.background,
      spineColor: c.spineColor,
      textColor: c.textColor,
      titleBand: c.titleBand,
      titlePosition: c.titlePosition,
      backFooter: c.backFooter,
    });
    const pdf = await saveFile({
      tenantId,
      name: `${slug(book.title)}-cover.pdf`,
      bytes: r.pdf,
      mime: 'application/pdf',
      kind: 'knowledge',
      source: 'agent',
      meta: { bookId: book.id, role: 'cover', pageCount, spineIn: r.geometry.spineIn, widthIn: r.geometry.widthIn, heightIn: r.geometry.heightIn },
    });
    // The preview is an ASSET (public URL) so it can be looked at in chat and
    // pasted back for vision; it carries no more than the cover itself.
    const preview = await saveFile({
      tenantId,
      name: `${slug(book.title)}-cover-preview.png`,
      bytes: r.previewPng,
      mime: 'image/png',
      kind: 'asset',
      source: 'agent',
      meta: { bookId: book.id, role: 'cover-preview', pageCount },
    });
    await updateBook(tenantId, book.id, { coverFileId: pdf?.id ?? null, coverPreviewFileId: preview?.id ?? null });
    return { pdf, preview, r };
  };

  // ── executors ────────────────────────────────────────────────────────────

  executors.set('list_books', {
    policy: 'auto',
    call: async () => {
      const rows = await listBooks(tenantId);
      if (rows.length === 0) {
        return 'No book projects yet. Start one with create_book (ask for title, trim size and whether it is a coloring book).';
      }
      return JSON.stringify(rows.map(b => ({ ...bookView(b), lastPreflight: b.lastPreflight })));
    },
  });

  executors.set('create_book', {
    policy: 'auto',
    call: async (args) => {
      const title = String(args.title ?? '').trim();
      if (!title) {
        throw new Error('A title is required.');
      }
      const trim = parseTrim(String(args.trimSize ?? ''));
      if (!trim) {
        throw new Error(`Could not read trim size "${String(args.trimSize)}". Use the form "8.5x8.5" (inches). Standard sizes: ${TRIM_SIZES.map(t => t.label).join(', ')}.`);
      }
      const kind = (['coloring', 'illustrated', 'text'].includes(String(args.kind)) ? String(args.kind) : 'coloring') as BookKind;
      const ink = (['black', 'color-standard', 'color-premium'].includes(String(args.ink)) ? String(args.ink) : 'black') as InkType;
      const paper = (args.paper === 'cream' ? 'cream' : 'white') as PaperType;
      if (ink !== 'black' && paper === 'cream') {
        throw new Error('Colour ink is only printed on white paper.');
      }
      const book = await createBook({
        tenantId,
        title,
        subtitle: args.subtitle ? String(args.subtitle) : undefined,
        author: args.author ? String(args.author) : undefined,
        kind,
        trim,
        bleed: typeof args.bleed === 'boolean' ? args.bleed : kind === 'illustrated',
        paper,
        ink,
        singleSided: typeof args.singleSided === 'boolean' ? args.singleSided : kind === 'coloring',
      });
      const page = interiorPageIn(book.trim, book.bleed);
      const limits = pageLimits(book.ink, book.paper);
      return JSON.stringify({
        created: bookView(book),
        artSpec: {
          note: book.bleed
            ? `Art must be ${page.widthIn} x ${page.heightIn} in (${inToPx(page.widthIn)} x ${inToPx(page.heightIn)} px at 300 dpi) — trim plus bleed; it is cropped to fill.`
            : `Art is placed inside the margins at 300 dpi; a ${book.trim.widthIn}:${book.trim.heightIn} ratio image (e.g. ${inToPx(book.trim.widthIn)} x ${inToPx(book.trim.heightIn)} px) fits best. Keep line work away from the edges — the safe area starts 0.25 in in (0.375 in on the spine side).`,
          pageLimits: `${limits.min}–${limits.max} physical pages${book.singleSided ? ' (single-sided: each art page counts as 2)' : ''}.`,
          nextSteps: 'Add pages with set_book_pages (existing files) or import_book_pages (a PDF/images), generate more with generate_image → prepare_line_art, set the cover with build_book_cover, then build_kdp_package.',
        },
      });
    },
  });

  executors.set('get_book', {
    policy: 'auto',
    call: async (args) => {
      const book = await resolveBook(tenantId, String(args.book ?? ''));
      const pre = await runPreflight(book);
      const geometry = coverGeometry({ trim: book.trim, pageCount: pre.physicalCount, paper: book.paper, ink: book.ink });
      return JSON.stringify({
        ...bookView(book),
        physicalPages: pre.physicalCount,
        pages: pre.loaded.map((l, i) => ({
          position: i + 1,
          kind: l.page.kind,
          ...(l.page.kind === 'art' ? { fileId: l.page.fileId, name: l.name, url: l.url, px: l.width && l.height ? `${l.width}x${l.height}` : undefined, missing: l.missing || undefined } : {}),
          ...(l.page.kind === 'text' ? { heading: l.page.heading, lines: l.page.lines } : {}),
          ...('label' in l.page && l.page.label ? { label: l.page.label } : {}),
        })),
        cover: book.cover,
        listing: book.listing,
        spineIn: geometry.spineIn,
        coverSizeIn: `${geometry.widthIn} x ${geometry.heightIn}`,
        preflight: summarise(pre.issues),
      });
    },
  });

  executors.set('update_book', {
    policy: 'auto',
    call: async (args) => {
      const book = await resolveBook(tenantId, String(args.book ?? ''));
      const patch: Parameters<typeof updateBook>[2] = {};
      if (args.title !== undefined) {
        patch.title = String(args.title);
      }
      if (args.subtitle !== undefined) {
        patch.subtitle = String(args.subtitle) || null;
      }
      if (args.author !== undefined) {
        patch.author = String(args.author) || null;
      }
      if (args.kind !== undefined && ['coloring', 'illustrated', 'text'].includes(String(args.kind))) {
        patch.kind = String(args.kind) as BookKind;
      }
      if (args.trimSize !== undefined) {
        const t = parseTrim(String(args.trimSize));
        if (!t) {
          throw new Error(`Could not read trim size "${String(args.trimSize)}".`);
        }
        patch.trim = t;
      }
      if (typeof args.bleed === 'boolean') {
        patch.bleed = args.bleed;
      }
      if (args.paper === 'white' || args.paper === 'cream') {
        patch.paper = args.paper;
      }
      if (['black', 'color-standard', 'color-premium'].includes(String(args.ink))) {
        patch.ink = String(args.ink) as InkType;
      }
      if (typeof args.singleSided === 'boolean') {
        patch.singleSided = args.singleSided;
      }
      if (['draft', 'ready', 'published'].includes(String(args.status))) {
        patch.status = String(args.status) as Book['status'];
      }
      if (args.listing && typeof args.listing === 'object') {
        const l = args.listing as Record<string, unknown>;
        const merged: BookListing = { ...book.listing };
        if (l.description !== undefined) {
          merged.description = String(l.description).slice(0, 4000);
        }
        if (Array.isArray(l.keywords)) {
          merged.keywords = l.keywords.map(String).map(s => s.trim()).filter(Boolean).slice(0, 7);
        }
        if (Array.isArray(l.categories)) {
          merged.categories = l.categories.map(String).map(s => s.trim()).filter(Boolean).slice(0, 3);
        }
        if (typeof l.priceUsd === 'number') {
          merged.priceUsd = l.priceUsd;
        }
        if (l.language !== undefined) {
          merged.language = String(l.language);
        }
        if (l.ageRange !== undefined) {
          merged.ageRange = String(l.ageRange);
        }
        patch.listing = merged;
      }
      if (args.cover && typeof args.cover === 'object') {
        patch.cover = mergeCover(book.cover, args.cover as Record<string, unknown>);
      }
      const updated = await updateBook(tenantId, book.id, patch);
      const changed = Object.keys(patch);
      return JSON.stringify({
        updated: bookView(updated),
        changed,
        ...(changed.some(k => ['trim', 'bleed', 'paper', 'ink', 'singleSided'].includes(k)) && (updated.interiorFileId || updated.coverFileId)
          ? { note: 'Print settings changed — the previously built interior/cover PDFs are stale. Rebuild with build_kdp_package.' }
          : {}),
      });
    },
  });

  executors.set('set_book_pages', {
    policy: 'auto',
    call: async (args) => {
      const book = await resolveBook(tenantId, String(args.book ?? ''));
      const incoming = parsePages(args.pages);
      // verify every art file exists in THIS workspace before touching order
      for (const p of incoming) {
        if (p.kind === 'art' && !(await getFile(tenantId, p.fileId))) {
          throw new Error(`No file with id "${p.fileId}" in this workspace — call list_files for current ids.`);
        }
      }
      const mode = String(args.mode ?? 'append');
      let pages: BookPage[];
      if (mode === 'replace') {
        pages = incoming;
      } else if (mode === 'insert') {
        const at = Math.max(1, Math.min(book.pages.length + 1, Math.round(Number(args.at ?? 1))));
        pages = [...book.pages.slice(0, at - 1), ...incoming, ...book.pages.slice(at - 1)];
      } else {
        pages = [...book.pages, ...incoming];
      }
      if (pages.length > MAX_PAGES) {
        throw new Error(`A book is capped at ${MAX_PAGES} logical pages.`);
      }
      const updated = await updateBook(tenantId, book.id, { pages });
      return JSON.stringify({ book: updated.title, logicalPages: updated.pages.length, physicalPages: physicalCount(updated), mode });
    },
  });

  executors.set('remove_book_pages', {
    policy: 'auto',
    call: async (args) => {
      const book = await resolveBook(tenantId, String(args.book ?? ''));
      const positions = new Set((Array.isArray(args.positions) ? args.positions : []).map(n => Math.round(Number(n))));
      const pages = book.pages.filter((_, i) => !positions.has(i + 1));
      const removed = book.pages.length - pages.length;
      const updated = await updateBook(tenantId, book.id, { pages });
      return JSON.stringify({ removed, logicalPages: updated.pages.length, physicalPages: physicalCount(updated) });
    },
  });

  executors.set('import_book_pages', {
    policy: 'auto',
    call: async (args) => {
      const book = await resolveBook(tenantId, String(args.book ?? ''));
      const ids = (Array.isArray(args.fileIds) ? args.fileIds : []).map(String).map(s => s.trim()).filter(Boolean);
      if (ids.length === 0) {
        throw new Error('Pass at least one library file id (a PDF or images).');
      }
      const prepare = typeof args.prepare === 'boolean' ? args.prepare : book.kind === 'coloring';
      const threshold = typeof args.threshold === 'number' ? args.threshold : undefined;
      const added: Array<Record<string, unknown>> = [];
      const skipped: Array<Record<string, unknown>> = [];
      const stem = slug(book.title);
      let counter = book.pages.length;

      const savePage = async (bytes: Buffer, mime: string, ext: string, label: string, origin: Record<string, unknown>) => {
        counter++;
        let out = bytes;
        let outMime = mime;
        let outExt = ext;
        let ink: number | undefined;
        let size = await imageSize(bytes);
        if (prepare) {
          const r = await prepareLineArt(bytes, { threshold });
          out = r.png;
          outMime = 'image/png';
          outExt = 'png';
          ink = r.inkCoverage;
          size = { width: r.width, height: r.height, format: 'png' };
        }
        const file = await saveFile({
          tenantId,
          name: `${stem}-page-${String(counter).padStart(3, '0')}.${outExt}`,
          bytes: out,
          mime: outMime,
          kind: 'asset',
          source: 'agent',
          meta: { bookId: book.id, role: 'page', width: size?.width, height: size?.height, prepared: prepare, inkCoverage: ink, ...origin },
        });
        if (file) {
          added.push({ fileId: file.id, name: file.name, url: file.publicUrl, px: size ? `${size.width}x${size.height}` : undefined, inkCoverage: ink, label });
        }
      };

      for (const id of ids) {
        const { row, bytes } = await loadBytes(id);
        if (isPdf(row.name, row.mime)) {
          const { images, skipped: sk, pageCount } = await extractPdfImages(bytes, { max: MAX_PAGES - counter });
          if (images.length === 0) {
            skipped.push({ fileId: id, name: row.name, reason: `no extractable page images in this ${pageCount}-page PDF${sk.length ? ` (${sk[0]!.reason})` : ''} — if it was drawn as vectors, export it as PNG pages instead` });
            continue;
          }
          for (const img of images) {
            await savePage(img.bytes, img.mime, img.ext, `${row.name} p${img.page}`, { importedFrom: row.id, sourceName: row.name, sourcePage: img.page });
          }
          for (const s of sk) {
            skipped.push({ fileId: id, name: row.name, page: s.page, reason: s.reason });
          }
        } else if (isImage(row.name, row.mime)) {
          await savePage(bytes, row.mime ?? 'image/png', row.name.split('.').pop()?.toLowerCase() ?? 'png', row.name, { importedFrom: row.id, sourceName: row.name });
        } else {
          skipped.push({ fileId: id, name: row.name, reason: 'not a PDF or image' });
        }
        if (counter >= MAX_PAGES) {
          break;
        }
      }

      const newPages: BookPage[] = added.map(a => ({ kind: 'art', fileId: String(a.fileId), label: String(a.label) }));
      const updated = await updateBook(tenantId, book.id, { pages: [...book.pages, ...newPages] });
      return JSON.stringify({
        book: updated.title,
        imported: added.length,
        logicalPages: updated.pages.length,
        physicalPages: physicalCount(updated),
        pages: added,
        ...(skipped.length ? { skipped } : {}),
        note: prepare
          ? 'Pages were cleaned to pure black/white line art (originals untouched). Check inkCoverage: ~0 means lines were lost (re-import with a higher threshold), >0.4 means shading survived (lower it).'
          : 'Pages were imported as-is.',
      });
    },
  });

  executors.set('prepare_line_art', {
    policy: 'auto',
    call: async (args) => {
      const ids = (Array.isArray(args.fileIds) ? args.fileIds : []).map(String).map(s => s.trim()).filter(Boolean);
      if (ids.length === 0) {
        throw new Error('Pass at least one image file id.');
      }
      const opts = {
        threshold: typeof args.threshold === 'number' ? args.threshold : undefined,
        despeckle: typeof args.despeckle === 'number' ? args.despeckle : undefined,
        thicken: typeof args.thicken === 'number' ? args.thicken : undefined,
      };
      const book = args.book ? await resolveBook(tenantId, String(args.book)) : null;
      const results: Array<Record<string, unknown>> = [];
      const swap = new Map<string, string>();
      for (const id of ids) {
        const { row, bytes } = await loadBytes(id);
        if (!isImage(row.name, row.mime)) {
          results.push({ fileId: id, name: row.name, error: 'not an image' });
          continue;
        }
        const r = await prepareLineArt(bytes, opts);
        const base = row.name.replace(/\.[a-z0-9]+$/i, '').replace(/-lineart$/i, '');
        const file = await saveFile({
          tenantId,
          name: `${base}-lineart.png`,
          bytes: r.png,
          mime: 'image/png',
          kind: 'asset',
          source: 'agent',
          meta: { preparedFrom: row.id, width: r.width, height: r.height, inkCoverage: r.inkCoverage, threshold: opts.threshold ?? 160, ...(book ? { bookId: book.id, role: 'page' } : {}) },
        });
        if (file) {
          swap.set(id, file.id);
          results.push({ from: id, fileId: file.id, name: file.name, url: file.publicUrl, px: `${r.width}x${r.height}`, inkCoverage: r.inkCoverage });
        }
      }
      let swapped = 0;
      if (book && swap.size) {
        const pages = book.pages.map((p) => {
          if (p.kind === 'art' && swap.has(p.fileId)) {
            swapped++;
            return { ...p, fileId: swap.get(p.fileId)! };
          }
          return p;
        });
        await updateBook(tenantId, book.id, { pages });
      }
      return JSON.stringify({
        prepared: results,
        ...(book ? { swappedIntoBook: swapped } : {}),
        note: 'inkCoverage guide: 0.02–0.25 normal; ~0 lines lost → raise threshold; >0.4 shading survived → lower threshold or raise despeckle.',
      });
    },
  });

  executors.set('preflight_book', {
    policy: 'auto',
    call: async (args) => {
      const book = await resolveBook(tenantId, String(args.book ?? ''));
      const pre = await runPreflight(book);
      const summary = summarise(pre.issues);
      await updateBook(tenantId, book.id, { lastPreflight: summary });
      const page = interiorPageIn(book.trim, book.bleed);
      return JSON.stringify({
        book: book.title,
        physicalPages: pre.physicalCount,
        interiorPageSizeIn: `${page.widthIn} x ${page.heightIn}`,
        ...summary,
        kdpSettings: kdpSettings(book, pre.physicalCount),
      });
    },
  });

  executors.set('build_book_interior', {
    policy: 'auto',
    call: async (args) => {
      const book = await resolveBook(tenantId, String(args.book ?? ''));
      const { file, result, pre } = await renderInteriorFor(book, { force: Boolean(args.force) });
      return JSON.stringify({
        fileId: file?.id,
        name: file?.name,
        pageCount: result.pageCount,
        sizeMb: Math.round((result.bytes / 1048576) * 10) / 10,
        fontsEmbedded: result.fontsEmbedded,
        preflight: summarise(pre.issues),
        note: `Interior is ${result.pageCount} pages — the cover spine is sized from this number, so build_book_cover now (or build_kdp_package for both). The PDF is private in the library; the user downloads it from the Files page.`,
      });
    },
  });

  executors.set('build_book_cover', {
    policy: 'auto',
    call: async (args) => {
      const book0 = await resolveBook(tenantId, String(args.book ?? ''));
      const cover = mergeCover(book0.cover, args as Record<string, unknown>);
      const book = await updateBook(tenantId, book0.id, { cover });
      const pageCount = physicalCount(book);
      const { pdf, preview, r } = await renderCoverFor(book, pageCount);
      return JSON.stringify({
        coverFileId: pdf?.id,
        coverName: pdf?.name,
        previewFileId: preview?.id,
        previewUrl: preview?.publicUrl,
        sizeIn: `${r.geometry.widthIn} x ${r.geometry.heightIn}`,
        spineIn: r.geometry.spineIn,
        pageCountUsed: pageCount,
        px: `${r.widthPx}x${r.heightPx}`,
        notes: r.notes,
        note: 'Open previewUrl and LOOK at it before reporting success: title legible, nothing important near the edges, barcode box (bottom-right of the back) clear. If the page count changes later, rebuild — the spine width depends on it.',
      });
    },
  });

  executors.set('build_kdp_package', {
    policy: 'auto',
    call: async (args) => {
      const book0 = await resolveBook(tenantId, String(args.book ?? ''));
      const { file: interior, result, pre } = await renderInteriorFor(book0, { force: false });
      const book = (await resolveBook(tenantId, book0.id));
      const { pdf: cover, preview, r } = await renderCoverFor(book, result.pageCount);
      const settings = kdpSettings(book, result.pageCount);
      const listing = book.listing;
      const sheet = [
        `# KDP upload sheet — ${book.title}`,
        '',
        '## Paperback details',
        `- Title: ${book.title}`,
        `- Subtitle: ${book.subtitle ?? '(none)'}`,
        `- Author: ${book.author ?? '(set with update_book)'}`,
        `- Language: ${listing.language ?? 'English'}`,
        `- Description: ${listing.description ? '' : '(write one with update_book → listing.description)'}`,
        ...(listing.description ? ['', listing.description, ''] : []),
        `- Keywords (7): ${(listing.keywords ?? []).join(' | ') || '(none yet)'}`,
        `- Categories: ${(listing.categories ?? []).join(' | ') || '(pick up to 3 in KDP)'}`,
        `- Age range: ${listing.ageRange ?? '(optional)'}`,
        '',
        '## Print options (choose exactly these in KDP)',
        ...Object.entries(settings).map(([k, v]) => `- ${k}: ${v}`),
        '',
        '## Files',
        `- Manuscript (interior): ${interior?.name} — ${result.pageCount} pages`,
        `- Cover: ${cover?.name} — ${r.geometry.widthIn} x ${r.geometry.heightIn} in, spine ${r.geometry.spineIn} in`,
        '',
        '## Pricing',
        `- List price: ${listing.priceUsd ? `$${listing.priceUsd.toFixed(2)} USD` : '(set with update_book → listing.priceUsd; KDP shows the minimum once files are uploaded)'}`,
        '',
        '## Upload checklist (kdp.amazon.com → Create → Paperback)',
        '1. Paperback Details: enter title/subtitle/author/description/keywords/categories above. Leave "Low-content book" ticked ONLY if the book has no ISBN and is a coloring/activity book without narrative — KDP asks.',
        '2. Paperback Content: choose free KDP ISBN (unless you own one); set Print Options exactly as listed; upload the manuscript PDF, then the cover PDF ("Upload a cover you already have"); UNTICK "AI-generated content" only if that is true — KDP requires disclosure when AI made the images or text.',
        '3. Launch Previewer: page through it. Yellow warnings about margins mean art is near the trim; red errors mean stop and fix.',
        '4. Paperback Rights & Pricing: territories (all), price, expanded distribution optional. Publish. Review takes up to 72 hours.',
        '5. Order an author proof before announcing — screens lie about paper.',
      ].join('\n');
      const sheetFile = await saveFile({
        tenantId,
        name: `${slug(book.title)}-kdp-upload-sheet.md`,
        bytes: Buffer.from(sheet, 'utf8'),
        mime: 'text/markdown',
        kind: 'knowledge',
        source: 'agent',
        meta: { bookId: book.id, role: 'kdp-sheet' },
      });
      await updateBook(tenantId, book.id, { status: 'ready' });
      return JSON.stringify({
        status: 'ready',
        interior: { fileId: interior?.id, name: interior?.name, pageCount: result.pageCount, sizeMb: Math.round((result.bytes / 1048576) * 10) / 10 },
        cover: { fileId: cover?.id, name: cover?.name, previewUrl: preview?.publicUrl, sizeIn: `${r.geometry.widthIn} x ${r.geometry.heightIn}`, spineIn: r.geometry.spineIn, notes: r.notes },
        uploadSheet: { fileId: sheetFile?.id, name: sheetFile?.name },
        kdpSettings: settings,
        preflight: summarise(pre.issues),
        note: 'Amazon has no publishing API: the user downloads the two PDFs from the Files page and uploads them on kdp.amazon.com following the sheet. Look at the cover preview first. Set status published (update_book) once KDP approves.',
      });
    },
  });

  executors.set('delete_book', {
    policy: 'auto',
    call: async (args) => {
      const book = await resolveBook(tenantId, String(args.book ?? ''));
      const ok = await deleteBook(tenantId, book.id);
      return JSON.stringify({ deleted: ok, title: book.title, note: 'Page images and built PDFs remain in the file library.' });
    },
  });

  return { anthropicTools, executors };
}

// ─── pure helpers ───────────────────────────────────────────────────────────

function physicalCount(book: Book): number {
  let n = 0;
  for (const p of book.pages) {
    n += book.singleSided && p.kind === 'art' ? 2 : 1;
  }
  return n % 2 === 1 ? n + 1 : n;
}

function mergeCover(current: BookCover, incoming: Record<string, unknown>): BookCover {
  const c: BookCover = { ...current };
  const str = (k: keyof BookCover, max = 2000) => {
    if (incoming[k] !== undefined) {
      const v = String(incoming[k]).trim().slice(0, max);
      (c as Record<string, unknown>)[k] = v || undefined;
    }
  };
  str('frontArtFileId', 80);
  str('backArtFileId', 80);
  str('blurb');
  str('background', 9);
  str('spineColor', 9);
  str('textColor', 9);
  str('backFooter', 120);
  if (typeof incoming.spineText === 'boolean') {
    c.spineText = incoming.spineText;
  }
  if (typeof incoming.titleBand === 'boolean') {
    c.titleBand = incoming.titleBand;
  }
  if (incoming.titlePosition === 'top' || incoming.titlePosition === 'bottom') {
    c.titlePosition = incoming.titlePosition;
  }
  return c;
}

/** The exact Print Options a user must choose on KDP for this book. */
function kdpSettings(book: Book, pageCount: number): Record<string, string> {
  return {
    'Trim size': book.trim.label,
    'Bleed settings': book.bleed ? 'Bleed (PDF only)' : 'No bleed',
    'Interior & paper type': book.ink === 'black' ? `Black & white interior with ${book.paper} paper` : book.ink === 'color-premium' ? 'Premium colour interior with white paper' : 'Standard colour interior with white paper',
    'Paperback cover finish': 'Matte (glossy also fine — matte hides fingerprints on a coloring book)',
    'Page count': String(pageCount),
    'Spine width': `${coverGeometry({ trim: book.trim, pageCount, paper: book.paper, ink: book.ink }).spineIn} in`,
  };
}
