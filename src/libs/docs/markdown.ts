/**
 * Markdown → document blocks.
 *
 * WHY MARKDOWN IS THE INPUT. An agent writes markdown constantly and without
 * being asked — it is the format it drafts reports, proposals and summaries in
 * already. Asking it for a JSON block tree instead would mean it has to
 * translate its own draft into a schema, which is one more place to make a
 * mistake for no gain. Handing it raw HTML is worse: it invents layout, and a
 * PDF full of invented layout looks like a bug.
 *
 * So: the agent writes the document, this file turns it into a small block IR,
 * and BOTH renderers (Chrome/HTML and the pure-JS fallback) consume that IR.
 * That is what makes the fallback produce the same document rather than a
 * different-looking apology — the two paths share everything above the ink.
 *
 * This is deliberately NOT a full CommonMark implementation. It covers what
 * actually appears in a business document and ignores the rest (footnotes,
 * nested lists beyond one level, reference links, inline HTML), because a
 * half-supported feature that renders wrongly is worse than one that renders
 * as plain text.
 */

export type DocBlock
  = | { type: 'heading'; level: 1 | 2 | 3; text: string }
    | { type: 'paragraph'; text: string }
    | { type: 'list'; ordered: boolean; items: string[] }
    | { type: 'table'; headers: string[]; rows: string[][] }
    | { type: 'quote'; text: string }
    | { type: 'code'; text: string }
    | { type: 'image'; url: string; alt: string }
    | { type: 'divider' }
    | { type: 'pagebreak' };

/** Guard rails — a runaway document is a rendering timeout, not a feature. */
const MAX_BLOCKS = 4_000;
const MAX_TABLE_COLS = 12;

const HEADING = /^(#{1,6})[ \t]+(\S.*)$/;
const BULLET = /^[-*+][ \t]+(\S.*)$/;
const ORDERED = /^\d+[.)][ \t]+(\S.*)$/;
const QUOTE = /^>\s?(.*)$/;
const DIVIDER = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/;
const FENCE = /^\s*(?:```|~~~)/;
/**
 * An explicit page break. `\pagebreak`, `<!-- pagebreak -->` and `[pagebreak]`
 * are all accepted because the model will reach for whichever it saw last, and
 * a page break that silently renders as the literal text "\pagebreak" in the
 * middle of a client proposal is exactly the kind of small ugly failure nobody
 * checks for.
 */
const PAGEBREAK = /^(?:\\pagebreak|\[pagebreak\]|<!--[ \t]*pagebreak[ \t]*-->|\{pagebreak\})$/i;

/** A markdown table row: at least one unescaped pipe with content around it. */
function isTableRow(line: string): boolean {
  return line.includes('|') && /\|/.test(line.replace(/\\\|/g, ''));
}

/** The `|---|:--:|` separator under a table's header row. */
function isTableDivider(line: string): boolean {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.length > 1 && cells.every(cell => /^:?-+:?$/.test(cell.trim()));
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed
    .split(/(?<!\\)\|/)
    .map(cell => cell.replace(/\\\|/g, '|').trim())
    .slice(0, MAX_TABLE_COLS);
}

/**
 * Parse markdown into blocks. Never throws: anything unrecognised degrades to a
 * paragraph, because a document that renders imperfectly beats a tool call that
 * fails and leaves the user with nothing.
 */
export function parseMarkdown(markdown: string): DocBlock[] {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: DocBlock[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({
        type: 'paragraph',
        text: paragraph.join(' ').trim(),
      });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length && blocks.length < MAX_BLOCKS; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();

    if (line === '') {
      flush();
      continue;
    }

    // Fenced code: everything up to the closing fence is literal, so it must be
    // consumed here or a '# ' inside a snippet becomes a heading.
    if (FENCE.test(raw)) {
      flush();
      const body: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        if (FENCE.test(lines[i] ?? '')) {
          break;
        }
        body.push(lines[i] ?? '');
      }
      blocks.push({
        type: 'code',
        text: body.join('\n'),
      });
      continue;
    }

    if (PAGEBREAK.test(line)) {
      flush();
      blocks.push({ type: 'pagebreak' });
      continue;
    }

    if (DIVIDER.test(raw)) {
      flush();
      blocks.push({ type: 'divider' });
      continue;
    }

    const image = IMAGE.exec(line);
    if (image) {
      flush();
      blocks.push({
        type: 'image',
        url: image[2] ?? '',
        alt: image[1] ?? '',
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const hashes = (heading[1] ?? '#').length;
      blocks.push({
        type: 'heading',
        // h4-h6 collapse to h3: a business document with six heading levels is
        // a document nobody can read, and the renderers only style three.
        level: (hashes >= 3 ? 3 : hashes) as 1 | 2 | 3,
        text: (heading[2] ?? '').trim(),
      });
      continue;
    }

    // Table: header row + separator. Without the separator it is just a line
    // with pipes in it, which is usually prose.
    if (isTableRow(line) && isTableDivider(lines[i + 1] ?? '')) {
      flush();
      const headers = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      for (; i < lines.length; i++) {
        const next = (lines[i] ?? '').trim();
        if (next === '' || !isTableRow(next)) {
          break;
        }
        rows.push(splitRow(next));
      }
      i--;
      blocks.push({
        type: 'table',
        headers,
        rows,
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const parts = [(quote[1] ?? '').trim()];
      for (i++; i < lines.length; i++) {
        const more = QUOTE.exec((lines[i] ?? '').trim());
        if (!more) {
          break;
        }
        parts.push((more[1] ?? '').trim());
      }
      i--;
      blocks.push({
        type: 'quote',
        text: parts.join(' ').trim(),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flush();
      const isOrdered = Boolean(ordered);
      const items: string[] = [(bullet?.[1] ?? ordered?.[1] ?? '').trim()];
      for (i++; i < lines.length; i++) {
        const next = (lines[i] ?? '').trim();
        const nextItem = isOrdered ? ORDERED.exec(next) : BULLET.exec(next);
        if (nextItem) {
          items.push((nextItem[1] ?? '').trim());
          continue;
        }
        // An indented continuation line belongs to the item above it.
        if (next !== '' && /^\s{2,}\S/.test(lines[i] ?? '') && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1]} ${next}`;
          continue;
        }
        break;
      }
      i--;
      blocks.push({
        type: 'list',
        ordered: isOrdered,
        items,
      });
      continue;
    }

    paragraph.push(line);
  }

  flush();
  return blocks;
}

// ─── Inline formatting ───────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inline markdown → HTML. Escapes FIRST, then re-introduces only the tags this
 * function itself emits: agent-authored text routinely quotes a client's web
 * page, and a stray `<script>` in a proposal must render as characters, not run
 * inside the rendering browser.
 */
export function inlineHtml(text: string): string {
  let out = escapeHtml(String(text ?? ''));
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\b_([^_\n]+)_\b/g, '<em>$1</em>');
  return out;
}

/**
 * Inline markdown → plain text, for the fallback renderer which draws strings
 * rather than parsing tags. A link keeps its URL in parentheses: dropping it
 * would lose information the reader of a printed page cannot recover.
 */
export function inlinePlain(text: string): string {
  return String(text ?? '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_all, label: string, url: string) =>
      label.trim() === url.trim() ? url : `${label} (${url})`)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/\b_([^_\n]+)_\b/g, '$1');
}
