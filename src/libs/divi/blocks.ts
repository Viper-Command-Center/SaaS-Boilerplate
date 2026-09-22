/**
 * Divi 5 block-comment parser (Phase 47).
 *
 * Divi 5 stores a page as WordPress block comments:
 *   <!-- wp:divi/section {"builderVersion":"5.0.0"} -->
 *     <!-- wp:divi/row {...} -->
 *       <!-- wp:divi/column {...} -->
 *         <!-- wp:divi/text {...} /-->          ← leaf, self-closing
 *       <!-- /wp:divi/column -->
 *     <!-- /wp:divi/row -->
 *   <!-- /wp:divi/section -->
 *
 * This is a small, strict parser for that surface — enough to hand the
 * validator a tree with each block's attrs and its position in the markup.
 * It is deliberately NOT a general Gutenberg parser: anything that is not a
 * `wp:divi/*` block (core blocks, stray HTML) is reported, because Divi 5
 * renders none of it inside a builder page.
 */

export type DiviBlock = {
  /** e.g. "divi/section" */
  name: string;
  attrs: Record<string, unknown>;
  /** The attrs JSON exactly as written in the comment (for escaping checks). */
  rawAttrs?: string;
  /** attrs JSON was present but did not parse */
  attrsError?: string;
  selfClosing: boolean;
  children: DiviBlock[];
  /** 1-based line of the opening comment, for error messages */
  line: number;
  /** breadcrumb like "section[0] > row[0] > column[1] > blurb[0]" */
  path: string;
};

export type ParseResult = {
  roots: DiviBlock[];
  errors: string[];
  /** Number of block openings seen (leaf + container). */
  count: number;
};

const OPEN_RE = /<!--\s*wp:([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*)(?:\s+(\{[\s\S]*?\}))?\s*(\/)?-->/g;
const CLOSE_RE = /<!--\s*\/wp:([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*)\s*-->/y;

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      n++;
    }
  }
  return n;
}

/**
 * Parse block markup into a tree. Never throws — malformed input comes back
 * as `errors` so the caller can refuse the write with a message the model
 * can act on.
 */
export function parseDiviBlocks(markup: string): ParseResult {
  const errors: string[] = [];
  const roots: DiviBlock[] = [];
  const stack: DiviBlock[] = [];
  const counters: Array<Map<string, number>> = [new Map()];
  let count = 0;

  const short = (name: string) => name.replace(/^divi\//, '');
  const nextIndex = (name: string) => {
    const m = counters[counters.length - 1]!;
    const i = m.get(name) ?? 0;
    m.set(name, i + 1);
    return i;
  };

  let pos = 0;
  while (pos < markup.length) {
    const lt = markup.indexOf('<!--', pos);
    if (lt < 0) {
      break;
    }
    const gt = markup.indexOf('-->', lt);
    if (gt < 0) {
      errors.push(`line ${lineOf(markup, lt)}: unterminated HTML comment`);
      break;
    }
    const comment = markup.slice(lt, gt + 3);
    const line = lineOf(markup, lt);

    // Closing tag?
    CLOSE_RE.lastIndex = 0;
    const close = CLOSE_RE.exec(comment);
    if (close && close.index === 0 && close[0].length === comment.length) {
      const name = close[1]!;
      const top = stack[stack.length - 1];
      if (!top) {
        errors.push(`line ${line}: closing <!-- /wp:${name} --> with no open block`);
      } else if (top.name !== name) {
        errors.push(`line ${line}: closing <!-- /wp:${name} --> but the open block is wp:${top.name} (opened line ${top.line})`);
        // Recover: pop anyway so later structure still parses.
        stack.pop();
        counters.pop();
      } else {
        stack.pop();
        counters.pop();
      }
      pos = gt + 3;
      continue;
    }

    OPEN_RE.lastIndex = 0;
    const open = OPEN_RE.exec(comment);
    if (open && open.index === 0 && open[0].length === comment.length) {
      const name = open[1]!;
      const json = open[2];
      const selfClosing = Boolean(open[3]);
      let attrs: Record<string, unknown> = {};
      let attrsError: string | undefined;
      if (json) {
        try {
          const parsed = JSON.parse(json) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            attrs = parsed as Record<string, unknown>;
          } else {
            attrsError = 'attrs JSON is not an object';
          }
        } catch (e) {
          attrsError = describeJsonError(json, e);
        }
      }
      const parent = stack[stack.length - 1];
      const idx = nextIndex(name);
      const crumb = `${short(name)}[${idx}]`;
      const block: DiviBlock = {
        name,
        attrs,
        rawAttrs: json,
        attrsError,
        selfClosing,
        children: [],
        line,
        path: parent ? `${parent.path} > ${crumb}` : crumb,
      };
      count++;
      if (parent) {
        parent.children.push(block);
      } else {
        roots.push(block);
      }
      if (!selfClosing) {
        stack.push(block);
        counters.push(new Map());
      }
      pos = gt + 3;
      continue;
    }

    // Some other comment (a core block, a plain HTML comment). Divi 5 ignores
    // core blocks inside a builder page — say so rather than silently pass.
    if (/^<!--\s*\/?wp:/.test(comment)) {
      errors.push(`line ${line}: ${comment.slice(0, 60)}… is not a wp:divi/* block — only Divi blocks render inside a Divi 5 page`);
    }
    pos = gt + 3;
  }

  for (const open of stack) {
    errors.push(`line ${open.line}: <!-- wp:${open.name} --> is never closed (add <!-- /wp:${open.name} --> or make it self-closing with /-->)`);
  }

  return { roots, errors, count };
}

/**
 * A JSON syntax error with the offending neighbourhood quoted, so the model
 * can see the missing comma instead of guessing at "position 1187".
 */
function describeJsonError(json: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : 'syntax error';
  const m = /position (\d+)/.exec(msg);
  if (!m) {
    return `attrs JSON does not parse (${msg})`;
  }
  const pos = Number(m[1]);
  const from = Math.max(0, pos - 60);
  const to = Math.min(json.length, pos + 40);
  const before = json.slice(from, pos);
  const after = json.slice(pos, to);
  return `attrs JSON does not parse (${msg.replace(/ in JSON.*$/, '')}) — here: …${before}⟪HERE⟫${after}…`;
}

/**
 * Serialise a block tree back to Divi 5 markup with WordPress's own attribute
 * escaping (serialize_block_attributes): `--` `<` `>` `&` `"` become unicode
 * escapes so no HTML in an attribute can terminate the comment. This lets the
 * model write PLAIN JSON with ordinary HTML strings and leaves the escaping to
 * the platform — hand-escaping was the main source of unparseable attrs.
 */
export function serializeDiviBlocks(blocks: DiviBlock[], indent = ''): string {
  const out: string[] = [];
  for (const b of blocks) {
    const attrs = Object.keys(b.attrs).length > 0 ? ` ${escapeBlockAttrs(JSON.stringify(b.attrs))}` : '';
    if (b.selfClosing || (b.children.length === 0 && !isContainerName(b.name))) {
      out.push(`${indent}<!-- wp:${b.name}${attrs} /-->`);
      continue;
    }
    out.push(`${indent}<!-- wp:${b.name}${attrs} -->`);
    if (b.children.length > 0) {
      out.push(serializeDiviBlocks(b.children, indent));
    }
    out.push(`${indent}<!-- /wp:${b.name} -->`);
  }
  return out.join('\n');
}

const CONTAINER_NAMES = new Set(['divi/placeholder', 'divi/section', 'divi/row', 'divi/row-inner', 'divi/column', 'divi/column-inner', 'divi/group', 'divi/group-carousel']);
function isContainerName(name: string): boolean {
  return CONTAINER_NAMES.has(name);
}

/** WordPress serialize_block_attributes() escaping, byte for byte. */
export function escapeBlockAttrs(json: string): string {
  return json
    .replace(/--/g, '\\u002d\\u002d')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\\"/g, '\\u0022');
}

/** Depth-first walk. */
export function walkBlocks(blocks: DiviBlock[], fn: (b: DiviBlock, depth: number) => void, depth = 0): void {
  for (const b of blocks) {
    fn(b, depth);
    walkBlocks(b.children, fn, depth + 1);
  }
}
