/**
 * Reading PDFs — the other half of the feature, and the half clients notice.
 *
 * A workspace's file library is where briefs, contracts, invoices and reports
 * land, and most of them are PDFs. Until now `isTextual()` said no to every one
 * of them, so `read_file` answered "this file has no extractable text" and the
 * agent's only honest move was to ask the client to paste the document it had
 * just uploaded.
 *
 * TWO KINDS OF PDF, AND THEY ARE NOT THE SAME PROBLEM
 *
 *  1. Born-digital (exported from Word, Docs, an invoicing system). It carries
 *     a real text layer. `unpdf` — pdfjs packaged for serverless, pure JS, no
 *     native build — reads it in milliseconds for free. This is the common case
 *     and it must never cost a model call.
 *
 *  2. Scanned (a photographed contract, a faxed PO). No text layer at all: the
 *     page is a picture. Every pure-JS parser returns an empty string, which is
 *     indistinguishable from "the file is empty" unless somebody checks the
 *     page count — and that misread is how an agent ends up confidently
 *     summarising a document it never read. For these, and only these, Claude
 *     reads the pages itself as a document block.
 *
 * WHY OCR IS LAZY, NOT AT UPLOAD. Text-layer extraction is fast enough to run
 * inline while a file uploads. OCR is not: thirty pages is a multi-minute,
 * multi-dollar job, and doing it eagerly would bill every workspace for
 * scanning documents nobody ever opens, while making the upload spinner look
 * broken. So OCR happens the first time an agent actually reads the file, and
 * the result is written back to `textContent` — once per document, forever.
 */

import { Buffer } from 'node:buffer';
import { callClaudeWithTools } from '@/libs/agent/anthropic';
import { meterLlm } from '@/libs/billing/meter';

/** Below this many characters per page, treat the text layer as absent. */
const THIN_TEXT_PER_PAGE = 90;

/** Never OCR more than this — a 400-page scan is a support conversation. */
const MAX_OCR_PAGES = 30;

/** Pages per model call. Chunking keeps each response inside its token budget. */
const OCR_CHUNK_PAGES = 8;

/** The Anthropic document block tops out at 32MB; stay well under it. */
const MAX_OCR_BYTES = 20 * 1024 * 1024;

export type PdfExtraction = {
  /** Null when nothing could be read — never an empty string pretending to be a document. */
  text: string | null;
  pages: number;
  method: 'text-layer' | 'ocr' | 'none';
  /** Plain-English reason, safe to hand to the agent verbatim. */
  note?: string;
};

export function isPdf(name: string, mime?: string | null): boolean {
  return /^application\/pdf$/i.test(String(mime ?? '')) || /\.pdf$/i.test(String(name ?? ''));
}

/**
 * Read the embedded text layer.
 *
 * `unpdf` is imported dynamically on purpose: it pulls in pdfjs, which is large
 * and only needed on the handful of requests that touch a PDF. A static import
 * would load it into every server bundle that happens to reach files.ts.
 */
export async function extractPdfTextLayer(bytes: Buffer): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return {
    text: (Array.isArray(text) ? text.join('\n\n') : String(text ?? '')).trim(),
    pages: Number(totalPages) || 0,
  };
}

/** Split a PDF into page ranges so each model call stays a sane size. */
async function chunkPdf(bytes: Buffer, pageLimit: number): Promise<Buffer[]> {
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true });
  const total = Math.min(source.getPageCount(), pageLimit);
  if (total <= OCR_CHUNK_PAGES) {
    return [bytes];
  }

  const chunks: Buffer[] = [];
  for (let start = 0; start < total; start += OCR_CHUNK_PAGES) {
    const slice = await PDFDocument.create();
    const indices = Array.from(
      { length: Math.min(OCR_CHUNK_PAGES, total - start) },
      (_, i) => start + i,
    );
    const pages = await slice.copyPages(source, indices);
    pages.forEach(page => slice.addPage(page));
    chunks.push(Buffer.from(await slice.save()));
  }
  return chunks;
}

const OCR_SYSTEM = 'You transcribe scanned documents. Output ONLY the document\'s text content as clean '
  + 'markdown — headings as headings, tables as markdown tables, lists as lists. Preserve every number, '
  + 'date, name and amount exactly as printed. Do not summarise, do not comment, do not add anything that '
  + 'is not on the page. If a passage is genuinely illegible write [illegible] rather than guessing.';

/**
 * Transcribe a scanned PDF with the model.
 *
 * Returns null rather than throwing: OCR is a bonus path, and a workspace whose
 * provider does not accept document blocks should get "this looks like a scan
 * and I could not read it" — an accurate statement it can act on — not a failed
 * tool call in the middle of unrelated work.
 */
export async function ocrPdf(a: {
  bytes: Buffer;
  name: string;
  tenantId: string;
  pages: number;
}): Promise<{ text: string; pagesRead: number } | null> {
  if (a.bytes.length > MAX_OCR_BYTES) {
    return null;
  }

  let chunks: Buffer[];
  try {
    chunks = await chunkPdf(a.bytes, MAX_OCR_PAGES);
  } catch {
    return null;
  }

  const parts: string[] = [];
  let pagesRead = 0;

  for (const [index, chunk] of chunks.entries()) {
    try {
      const response = await callClaudeWithTools({
        system: OCR_SYSTEM,
        tools: [],
        maxTokens: 8_192,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: chunk.toString('base64'),
                },
              },
              {
                type: 'text',
                text: chunks.length > 1
                  ? `Transcribe part ${index + 1} of ${chunks.length} of "${a.name}".`
                  : `Transcribe "${a.name}".`,
              },
            ],
          },
        ],
      });

      // Metered like any other model call. An OCR pass that quietly skipped the
      // ledger would be a workspace paying nothing for the single most expensive
      // thing the file library can do.
      if (response.usage) {
        await meterLlm({
          tenantId: a.tenantId,
          modelId: response._modelId ?? 'unknown',
          usage: {
            inputTokens: response.usage.input_tokens ?? 0,
            outputTokens: response.usage.output_tokens ?? 0,
            cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
          },
          detail: `pdf-ocr:${a.name.slice(0, 60)}`,
        });
      }

      const text = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('\n')
        .trim();
      if (text) {
        parts.push(text);
        pagesRead += Math.min(OCR_CHUNK_PAGES, Math.max(a.pages - pagesRead, 0)) || OCR_CHUNK_PAGES;
      }
    } catch {
      // One failed chunk should not throw away the pages already transcribed.
      parts.push(`[part ${index + 1} of ${chunks.length} could not be read]`);
    }
  }

  const joined = parts.join('\n\n').trim();
  if (!joined || /^\[part \d/.test(joined)) {
    return null;
  }
  return {
    text: joined,
    pagesRead: Math.min(pagesRead || a.pages, a.pages || MAX_OCR_PAGES),
  };
}

/**
 * The whole pipeline: text layer first, model OCR only when the layer is
 * genuinely missing and the caller has opted in.
 *
 * `allowOcr` is false on the upload path (fast, free, inline) and true on the
 * read path (an agent is waiting for this document and a model call is cheaper
 * than the wrong answer).
 */
export async function extractPdfText(a: {
  bytes: Buffer;
  name: string;
  tenantId: string;
  allowOcr: boolean;
}): Promise<PdfExtraction> {
  let layer: { text: string; pages: number };
  try {
    layer = await extractPdfTextLayer(a.bytes);
  } catch (err) {
    return {
      text: null,
      pages: 0,
      method: 'none',
      note: `This PDF could not be parsed (${err instanceof Error ? err.message.slice(0, 120) : 'unknown error'}). It may be corrupt or password-protected.`,
    };
  }

  const perPage = layer.pages > 0 ? layer.text.length / layer.pages : layer.text.length;
  if (layer.text.length > 0 && perPage >= THIN_TEXT_PER_PAGE) {
    return {
      text: layer.text,
      pages: layer.pages,
      method: 'text-layer',
    };
  }

  if (!a.allowOcr) {
    return {
      text: layer.text || null,
      pages: layer.pages,
      method: layer.text ? 'text-layer' : 'none',
      note: 'This PDF has little or no text layer — it is probably a scan. It will be read with OCR the first time an agent opens it.',
    };
  }

  if (layer.pages > MAX_OCR_PAGES) {
    return {
      text: layer.text || null,
      pages: layer.pages,
      method: layer.text ? 'text-layer' : 'none',
      note: `This looks like a scanned document of ${layer.pages} pages, which is over the ${MAX_OCR_PAGES}-page OCR limit. Ask the client for a text PDF, or for the specific pages that matter.`,
    };
  }

  const ocr = await ocrPdf({
    bytes: a.bytes,
    name: a.name,
    tenantId: a.tenantId,
    pages: layer.pages,
  });
  if (!ocr) {
    return {
      text: layer.text || null,
      pages: layer.pages,
      method: layer.text ? 'text-layer' : 'none',
      note: 'This PDF has no text layer (it is a scan or an image-only export) and it could not be read visually. '
        + 'Tell the user what you tried and ask them for a text-based copy — do NOT guess at its contents.',
    };
  }

  return {
    text: ocr.text,
    pages: layer.pages,
    method: 'ocr',
    note: `Transcribed from a scanned document by reading the pages${layer.pages > ocr.pagesRead ? ` (first ${ocr.pagesRead} of ${layer.pages} pages)` : ''}. Numbers and names are read off an image, so verify anything critical against the original.`,
  };
}
