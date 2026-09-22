/**
 * Divi 5 block validator (Phase 47) — the gate every Divi write passes through.
 *
 * Why this exists: on 2026-09-21 the agent built a page from GUESSED attribute
 * paths (`module.decoration.font` on a Heading, a bare string for a Blurb
 * title, `"padding":"40px"`, an image `src` pointing at the workspace library)
 * and DiviOps accepted every byte. Divi 5 silently dropped everything it did
 * not recognise, the page rendered as unstyled text, and the agent — having
 * fetched a 404 — told the owner it "rendered cleanly". None of that can be
 * fixed by asking the model to be careful. It is fixed here, mechanically:
 *
 *   1. markup must parse as Divi 5 blocks with correct nesting;
 *   2. every module must be one of the vendor's mapped modules;
 *   3. every attribute path must exist in that module's element map
 *      (elements, decoration groups, innerContent, advanced);
 *   4. shapes the reference calls out — breakpoints, spacing, font keys,
 *      innerContent objects vs strings — must match;
 *   5. media must live on the target site, never on a workspace library URL;
 *   6. size caps, so a runaway write can never land.
 *
 * Errors name the path, say what is allowed, and point at the
 * `diviops_reference` module map to read — the fix, not just the fault.
 */

import type { DiviBlock } from './blocks';
import type { ModuleSchema } from './moduleMap';
import { parseDiviBlocks, walkBlocks } from './blocks';
import { canonicalModuleName, ELEMENT_SUBKEYS, ITEM_PARENT, ITEM_PARENTS, referenceNameFor, STRUCTURAL, UNIVERSAL_BLOCK_KEYS } from './moduleMap';

export type Issue = {
  level: 'error' | 'warning';
  /** block breadcrumb + attribute path */
  where: string;
  message: string;
  /** which diviops_reference module map answers this */
  consult?: string;
};

export type ValidationStats = {
  blocks: number;
  /** leaf module counts by name, e.g. { "divi/text": 4 } */
  modules: Record<string, number>;
  codeModules: number;
  images: number;
};

export type ValidationResult = {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  stats: ValidationStats;
};

export type ValidateOptions = {
  schema: ModuleSchema;
  /**
   * required — the whole page: exactly one divi/placeholder root (page_create, page_update_content)
   * forbidden — one or more bare sections (section_append, section_replace)
   * any — library items, theme-builder layouts, canvases
   */
  placeholder: 'required' | 'forbidden' | 'any';
  /** Host media must live on (e.g. "build9.churchwebglobal.com"). */
  siteHost?: string;
  maxBlocks?: number;
  maxChars?: number;
};

export const DEFAULT_MAX_BLOCKS = 200;
export const DEFAULT_MAX_CHARS = 400_000;

const BREAKPOINTS = new Set(['desktop', 'tablet', 'phone', 'tabletWide', 'phoneWide', 'desktopAbove', 'widescreen']);
const STATES = new Set(['value', 'hover', 'sticky']);
const FONT_KEYS = new Set(['family', 'weight', 'style', 'textAlign', 'color', 'size', 'letterSpacing', 'lineHeight', 'headingLevel', 'lineColor', 'lineStyle', 'textShadow']);
const FONT_ALIASES: Record<string, string> = { fontSize: 'size', fontWeight: 'weight', fontFamily: 'family', fontStyle: 'style', textColor: 'color', align: 'textAlign', level: 'headingLevel', tag: 'headingLevel' };
const SPACING_KEYS = new Set(['margin', 'padding']);
const SIDES = new Set(['top', 'right', 'bottom', 'left', 'syncVertical', 'syncHorizontal']);
const MEDIA_EXT_RE = /\.(?:jpe?g|png|gif|webp|avif|svg|mp4|webm|mp3|pdf)(?:\?|#|$)/i;
/** Workspace library / CDN hosts that must never be pasted into a client site. */
const LIBRARY_HOST_RE = /(?:^|\.)artivio\.ai$/i;

type Shape = 'string' | 'html' | { keys: string[]; required: string[] };

/**
 * innerContent shapes the vendor reference verifies in the Visual Builder.
 * Keyed "module:element". Modules not listed still get the breakpoint check.
 */
const INNER_SHAPES: Record<string, Shape> = {
  'divi/heading:title': 'string',
  'divi/text:content': 'html',
  'divi/code:content': 'html',
  'divi/fullwidth-code:content': 'html',
  'divi/button:button': { keys: ['text', 'linkUrl', 'linkTarget', 'rel'], required: ['text'] },
  'divi/image:image': { keys: ['src', 'id', 'alt', 'titleText', 'linkUrl', 'linkTarget', 'width', 'height'], required: ['src'] },
  'divi/fullwidth-image:image': { keys: ['src', 'id', 'alt', 'titleText', 'linkUrl', 'linkTarget'], required: ['src'] },
  'divi/icon:icon': { keys: ['unicode', 'type', 'weight', 'url', 'target'], required: ['unicode'] },
  'divi/blurb:title': { keys: ['text', 'url', 'target'], required: ['text'] },
  'divi/blurb:content': 'html',
  'divi/blurb:imageIcon': { keys: ['useIcon', 'icon', 'src', 'id', 'alt', 'titleText'], required: [] },
  'divi/number-counter:number': 'string',
  'divi/number-counter:title': 'string',
  'divi/circle-counter:number': 'string',
  'divi/circle-counter:title': 'string',
  'divi/counter:title': 'string',
  'divi/counter:percent': 'string',
  'divi/slide:title': 'string',
  'divi/slide:button': { keys: ['text', 'linkUrl', 'linkTarget', 'rel'], required: ['text'] },
  'divi/slide:image': { keys: ['src', 'id', 'alt', 'titleText'], required: [] },
  'divi/slide:content': 'html',
  'divi/testimonial:author': 'string',
  'divi/testimonial:jobTitle': 'string',
  'divi/testimonial:company': { keys: ['text', 'linkUrl', 'linkTarget'], required: [] },
  'divi/testimonial:portrait': { keys: ['url', 'id', 'alt'], required: [] },
  'divi/testimonial:content': 'html',
  'divi/video:video': { keys: ['src', 'srcWebm'], required: ['src'] },
  'divi/video:thumbnail': { keys: ['src', 'id', 'alt'], required: [] },
  'divi/tab:title': 'string',
  'divi/tab:content': 'html',
  'divi/toggle:title': 'string',
  'divi/toggle:content': 'html',
  'divi/accordion-item:title': 'string',
  'divi/accordion-item:content': 'html',
  'divi/contact-form:title': 'string',
  'divi/contact-form:button': { keys: ['text'], required: ['text'] },
  'divi/contact-field:fieldItem': 'string',
  'divi/signup:title': 'string',
  'divi/signup:content': 'html',
  'divi/signup-custom-field:fieldItem': 'string',
  'divi/login:title': 'string',
  'divi/login:content': 'html',
  'divi/login:button': { keys: ['text', 'linkUrl'], required: ['text'] },
  'divi/countdown-timer:title': 'string',
  'divi/cta:title': 'string',
  'divi/cta:content': 'html',
  'divi/cta:button': { keys: ['text', 'linkUrl', 'linkTarget', 'rel'], required: ['text'] },
  'divi/team-member:name': 'string',
  'divi/team-member:position': 'string',
  'divi/team-member:content': 'html',
  'divi/team-member:image': { keys: ['src', 'id', 'alt', 'titleText'], required: [] },
  'divi/icon-list-item:title': 'string',
  'divi/pricing-table:title': 'string',
  'divi/pricing-table:subtitle': 'string',
  'divi/pricing-table:content': 'html',
  'divi/pricing-table:button': { keys: ['text', 'linkUrl', 'linkTarget', 'rel'], required: [] },
  'divi/timeline-item:title': 'string',
  'divi/timeline-item:content': 'html',
  'divi/fullwidth-header:title': 'string',
  'divi/fullwidth-header:subhead': 'string',
  'divi/fullwidth-header:content': 'html',
  'divi/breadcrumbs:home': { keys: ['text', 'url'], required: [] },
  'divi/breadcrumbs:separator': { keys: ['text'], required: [] },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function short(name: string): string {
  return name.replace(/^divi\//, '');
}

function fmtList(items: Iterable<string>): string {
  return [...items].sort().join(', ');
}

class Collector {
  errors: Issue[] = [];
  warnings: Issue[] = [];
  err(where: string, message: string, consult?: string) {
    this.errors.push({ level: 'error', where, message, consult });
  }

  warn(where: string, message: string, consult?: string) {
    this.warnings.push({ level: 'warning', where, message, consult });
  }
}

/** Validate Divi 5 block markup. Never throws. */
export function validateDiviMarkup(markup: string, opts: ValidateOptions): ValidationResult {
  const c = new Collector();
  const stats: ValidationStats = { blocks: 0, modules: {}, codeModules: 0, images: 0 };
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;

  if (typeof markup !== 'string' || markup.trim() === '') {
    c.err('content', 'content is empty — nothing to write.');
    return finish(c, stats);
  }
  if (markup.length > maxChars) {
    c.err('content', `content is ${markup.length.toLocaleString()} characters; the cap is ${maxChars.toLocaleString()}. Write the page in sections (section_append) instead of one payload.`);
    return finish(c, stats);
  }

  const parsed = parseDiviBlocks(markup);
  stats.blocks = parsed.count;
  for (const e of parsed.errors) {
    c.err('markup', e);
  }
  if (parsed.count === 0) {
    c.err('markup', 'no wp:divi/* blocks found — Divi 5 pages are block comments (<!-- wp:divi/section {...} --> …), not HTML. Read diviops_reference {file:"minimal-snippets"} for the shape.');
    return finish(c, stats);
  }
  if (parsed.count > maxBlocks) {
    c.err('content', `${parsed.count} blocks in one write; the cap is ${maxBlocks}. Split the work across sections.`);
  }

  // ── Placeholder / root expectations ────────────────────────────────────────
  const roots = parsed.roots;
  const placeholders = roots.filter(r => r.name === 'divi/placeholder');
  if (opts.placeholder === 'required') {
    if (roots.length !== 1 || placeholders.length !== 1) {
      c.err('markup', `a whole page must be exactly one <!-- wp:divi/placeholder --> … <!-- /wp:divi/placeholder --> wrapper containing the sections; found ${roots.length} root block(s) (${roots.map(r => short(r.name)).join(', ') || 'none'}).`);
    }
  } else if (opts.placeholder === 'forbidden') {
    if (placeholders.length > 0) {
      c.err('markup', 'this tool takes bare section(s) — remove the divi/placeholder wrapper (a nested placeholder renders the page blank).');
    }
    for (const r of roots) {
      if (r.name !== 'divi/section') {
        c.err(r.path, `root block must be a divi/section for this tool, found ${r.name}. Wrap modules in section → row → column.`);
      }
    }
  }

  // ── Per-block checks ───────────────────────────────────────────────────────
  const schema = opts.schema;
  const parentOf = new Map<DiviBlock, DiviBlock | null>();
  for (const r of roots) {
    parentOf.set(r, null);
    walkBlocks(r.children, () => {});
  }
  walkBlocks(roots, (b) => {
    for (const ch of b.children) {
      parentOf.set(ch, b);
    }
  });

  walkBlocks(roots, (b) => {
    const parent = parentOf.get(b) ?? null;
    checkNesting(b, parent, c);

    if (b.name === 'divi/placeholder') {
      return;
    }
    if (b.attrsError) {
      c.err(b.path, `${b.attrsError} — the attrs must be one JSON object between the block name and -->.`);
      return;
    }
    // Raw HTML / "--" inside attrs are fine here: the gate re-serialises every
    // block with WordPress's own escaping before the write (blocks.ts).

    const spec = schema.modules.get(b.name);
    if (!spec) {
      const guess = nearestModule(b.name, schema);
      c.err(b.path, `${b.name} is not a Divi 5 module${guess ? ` — did you mean ${guess}?` : ''}. Call diviops_reference with no arguments for the list.`);
      return;
    }
    if (!STRUCTURAL.has(b.name)) {
      stats.modules[b.name] = (stats.modules[b.name] ?? 0) + 1;
      if (b.name === 'divi/code' || b.name === 'divi/fullwidth-code') {
        stats.codeModules++;
      }
    }
    checkAttrs(b, spec.elements, c, stats, opts);
  });

  if (stats.codeModules > 0) {
    c.warn('content', `${stats.codeModules} Code module(s) in this write. A Code module is only for a genuine third-party embed or a snippet the owner supplied verbatim — never for headings, text, buttons or layouts that have a native module.`, 'Code');
  }

  return finish(c, stats);
}

function finish(c: Collector, stats: ValidationStats): ValidationResult {
  return { ok: c.errors.length === 0, errors: c.errors, warnings: c.warnings, stats };
}

function nearestModule(name: string, schema: ModuleSchema): string | null {
  const want = canonicalModuleName(name).replace(/^divi\//, '');
  let best: string | null = null;
  let bestScore = 0;
  for (const m of schema.modules.keys()) {
    const s = m.replace(/^divi\//, '');
    if (s === want) {
      return m;
    }
    if (s.includes(want) || want.includes(s)) {
      const score = Math.min(s.length, want.length);
      if (score > bestScore) {
        best = m;
        bestScore = score;
      }
    }
  }
  return best;
}

function checkNesting(b: DiviBlock, parent: DiviBlock | null, c: Collector): void {
  const n = b.name;
  const p = parent?.name ?? null;
  const at = b.path;

  // Containers must not be self-closing; leaves must not have children.
  if (STRUCTURAL.has(n) && n !== 'divi/placeholder' && b.selfClosing) {
    c.err(at, `${n} is a container — it cannot be self-closing (/-->); it needs children and a closing <!-- /wp:${n} -->.`);
  }
  if (!STRUCTURAL.has(n) && !ITEM_PARENTS.has(n) && b.children.length > 0) {
    c.err(at, `${n} is a leaf module and cannot contain other blocks (found ${b.children.map(ch => short(ch.name)).join(', ')}). Leaf modules are self-closing: <!-- wp:${n} {...} /-->.`);
  }
  if (!STRUCTURAL.has(n) && !ITEM_PARENTS.has(n) && !b.selfClosing && b.children.length === 0) {
    c.warn(at, `${n} is written with a separate closing tag; Divi writes leaf modules self-closing (/-->).`);
  }

  const expectParent = ITEM_PARENT[n];
  if (expectParent) {
    if (!p || !expectParent.includes(p)) {
      c.err(at, `${n} must sit directly inside ${expectParent.join(' or ')}, not ${p ?? 'the root'}.`);
    }
    return;
  }

  switch (n) {
    case 'divi/placeholder':
      if (p) {
        c.err(at, 'divi/placeholder can only be the outermost wrapper of a whole page.');
      }
      break;
    case 'divi/section':
      if (p && p !== 'divi/placeholder') {
        c.err(at, `a section can only sit at the page root (inside divi/placeholder), not inside ${p}.`);
      }
      break;
    case 'divi/row':
      if (p !== 'divi/section') {
        c.err(at, `a row must be inside a section, not ${p ?? 'the root'}.`);
      }
      break;
    case 'divi/row-inner':
      if (p !== 'divi/column') {
        c.err(at, `a row-inner belongs inside a specialty-section column, not ${p ?? 'the root'}.`);
      }
      break;
    case 'divi/column':
      if (p !== 'divi/row' && p !== 'divi/section') {
        c.err(at, `a column must be inside a row (or directly in a specialty section), not ${p ?? 'the root'}.`);
      }
      break;
    case 'divi/column-inner':
      if (p !== 'divi/row-inner') {
        c.err(at, `a column-inner must be inside a row-inner, not ${p ?? 'the root'}.`);
      }
      break;
    default: {
      // Ordinary or fullwidth module.
      if (n.startsWith('divi/fullwidth-')) {
        if (p !== 'divi/section') {
          c.err(at, `${n} is a fullwidth module and must sit directly inside a section (no row/column), not ${p ?? 'the root'}.`);
        }
      } else if (!p || !['divi/column', 'divi/column-inner', 'divi/group', 'divi/group-carousel'].includes(p)) {
        if (p && ITEM_PARENTS.has(p)) {
          c.err(at, `${n} cannot be a child of ${p}; that container only accepts ${Object.entries(ITEM_PARENT).filter(([, ps]) => ps.includes(p)).map(([k]) => k).join(' / ')}.`);
        } else {
          c.err(at, `${n} must be inside a column (section → row → column → module), not ${p ?? 'the root'}. Wrapperless modules lose all styling.`);
        }
      }
    }
  }
}

function checkAttrs(b: DiviBlock, elements: Map<string, { groups: Set<string>; innerContent: boolean; advanced: boolean }>, c: Collector, stats: ValidationStats, opts: ValidateOptions): void {
  const at = b.path;
  const ref = referenceNameFor(b.name);
  const attrs = b.attrs;

  if (!('builderVersion' in attrs) && b.name !== 'divi/placeholder') {
    c.warn(at, 'builderVersion is missing; every block should carry "builderVersion" (e.g. "5.0.0").');
  }
  if ('modulePreset' in attrs && typeof attrs.modulePreset === 'string') {
    c.warn(at, 'modulePreset should be an array (["default"]), not a string — the string form is D4-legacy.');
  }

  for (const [key, val] of Object.entries(attrs)) {
    if (UNIVERSAL_BLOCK_KEYS.has(key)) {
      continue;
    }
    const elem = elements.get(key);
    if (!elem) {
      const hint = elementHint(b.name, key, elements);
      c.err(`${at}.${key}`, `"${key}" is not an element of ${b.name}. Elements: ${fmtList(elements.keys())}.${hint ? ` ${hint}` : ''}`, ref);
      continue;
    }
    if (!isObj(val)) {
      c.err(`${at}.${key}`, `"${key}" must be an object with decoration / innerContent / advanced, not ${typeof val}.`, ref);
      continue;
    }
    for (const [sub, subVal] of Object.entries(val)) {
      const where = `${at}.${key}.${sub}`;
      if (!ELEMENT_SUBKEYS.has(sub)) {
        c.err(where, `"${sub}" is not valid under ${key}; use decoration, advanced or innerContent (meta only on module).`, ref);
        continue;
      }
      if (sub === 'meta' && key !== 'module') {
        c.err(where, 'meta (adminLabel) lives under module.meta only.', ref);
        continue;
      }
      if (sub === 'innerContent') {
        if (!elem.innerContent) {
          c.err(where, `${key} on ${b.name} has no innerContent — this element is decoration-only. Elements with content: ${fmtList([...elements].filter(([, e]) => e.innerContent).map(([k]) => k)) || 'none'}.`, ref);
          continue;
        }
        checkBreakpoints(where, subVal, c, ref);
        checkInnerShape(b.name, key, where, subVal, c, ref, stats, opts);
        continue;
      }
      if (sub === 'advanced') {
        if (!elem.advanced) {
          c.warn(where, `${key} on ${b.name} is not documented with an advanced bag — confirm the path in the reference before relying on it.`, ref);
        }
        if (!isObj(subVal)) {
          c.err(where, 'advanced must be an object of named settings, each with breakpoints.', ref);
        }
        continue;
      }
      if (sub === 'meta') {
        continue;
      }
      // decoration
      if (!isObj(subVal)) {
        c.err(where, 'decoration must be an object of groups (font, spacing, background, …).', ref);
        continue;
      }
      for (const [group, groupVal] of Object.entries(subVal)) {
        const gw = `${where}.${group}`;
        if (!elem.groups.has(group)) {
          const elsewhere = [...elements].filter(([, e]) => e.groups.has(group)).map(([k]) => k);
          c.err(gw, `${key}.decoration.${group} does not exist on ${b.name}. Groups on ${key}: ${fmtList(elem.groups) || 'none'}.${elsewhere.length ? ` "${group}" belongs to ${elsewhere.map(e => `${e}.decoration.${group}`).join(', ')}.` : ''}`, ref);
          continue;
        }
        checkGroup(b.name, group, gw, groupVal, c, ref, stats, opts);
      }
    }
  }
}

function elementHint(moduleName: string, key: string, elements: Map<string, unknown>): string {
  const k = key.toLowerCase();
  if (['src', 'alt', 'id', 'url', 'image'].includes(k) && elements.has('image')) {
    return 'Image source goes in image.innerContent.desktop.value {src, alt, id}.';
  }
  if (['text', 'title', 'heading'].includes(k) && elements.has('title')) {
    return `Text goes in title.innerContent.desktop.value${moduleName === 'divi/heading' ? ' (a plain string)' : ' ({text: "…"})'}.`;
  }
  if (['content', 'html', 'body'].includes(k) && elements.has('content')) {
    return 'Body text goes in content.innerContent.desktop.value (an HTML string).';
  }
  if (['adminLabel', 'label', 'name'].includes(key)) {
    return 'Admin labels go in module.meta.adminLabel.desktop.value.';
  }
  if (['background', 'padding', 'margin', 'spacing', 'font', 'color', 'sizing', 'width', 'height', 'border'].includes(k)) {
    return `Design settings go under an element's decoration groups, e.g. module.decoration.${['padding', 'margin'].includes(k) ? 'spacing' : ['color'].includes(k) ? 'background' : ['width', 'height'].includes(k) ? 'sizing' : k}.desktop.value.`;
  }
  return '';
}

/** Every group / innerContent is keyed by breakpoint, then state. */
function checkBreakpoints(where: string, val: unknown, c: Collector, ref: string): void {
  if (!isObj(val)) {
    c.err(where, 'must be an object keyed by breakpoint: {desktop: {value: …}} (tablet / phone optional).', ref);
    return;
  }
  const keys = Object.keys(val);
  if (keys.length === 0) {
    c.warn(where, 'is an empty object — nothing will be applied.', ref);
    return;
  }
  for (const bp of keys) {
    if (!BREAKPOINTS.has(bp)) {
      if (STATES.has(bp)) {
        c.err(`${where}.${bp}`, `"${bp}" sits directly under the group — it must be nested under a breakpoint: ${where}.desktop.${bp}.`, ref);
      } else {
        c.err(`${where}.${bp}`, `"${bp}" is not a breakpoint. Use desktop, tablet or phone, each holding {value: …} (and optionally hover / sticky).`, ref);
      }
      continue;
    }
    const st = (val as Record<string, unknown>)[bp];
    if (!isObj(st)) {
      c.err(`${where}.${bp}`, 'must be an object {value: …}.', ref);
      continue;
    }
    for (const s of Object.keys(st)) {
      if (!STATES.has(s)) {
        c.err(`${where}.${bp}.${s}`, `"${s}" is not a state — wrap the setting in "value" (${where}.${bp}.value.${s}).`, ref);
      }
    }
  }
}

function eachValue(val: unknown, fn: (bp: string, state: string, v: unknown) => void): void {
  if (!isObj(val)) {
    return;
  }
  for (const [bp, st] of Object.entries(val)) {
    if (!isObj(st)) {
      continue;
    }
    for (const [state, v] of Object.entries(st)) {
      fn(bp, state, v);
    }
  }
}

function checkGroup(moduleName: string, group: string, where: string, val: unknown, c: Collector, ref: string, stats: ValidationStats, opts: ValidateOptions): void {
  // Font groups nest one level deeper (font.font.desktop…), so the generic
  // breakpoint check runs inside their branch, not here.
  if (group !== 'font' && group !== 'bodyFont' && group !== 'headingFont') {
    checkBreakpoints(where, val, c, ref);
  }

  if (group === 'spacing') {
    eachValue(val, (bp, state, v) => {
      const w = `${where}.${bp}.${state}`;
      if (!isObj(v)) {
        c.err(w, 'spacing value must be an object {padding: {top,right,bottom,left}, margin: {…}}.', ref);
        return;
      }
      for (const [k, side] of Object.entries(v)) {
        if (!SPACING_KEYS.has(k)) {
          c.err(`${w}.${k}`, `"${k}" is not a spacing key; use padding or margin.`, ref);
          continue;
        }
        if (!isObj(side)) {
          c.err(`${w}.${k}`, `${k} must be an object of sides — {"top":"40px","right":"40px","bottom":"40px","left":"40px"} — not ${JSON.stringify(side)}. A bare "40px" is silently dropped by Divi.`, ref);
          continue;
        }
        for (const [s, sv] of Object.entries(side)) {
          if (!SIDES.has(s)) {
            c.err(`${w}.${k}.${s}`, `"${s}" is not a side; use top, right, bottom, left (plus syncVertical / syncHorizontal).`, ref);
          } else if (typeof sv === 'string' && /^\d+(?:\.\d+)?$/.test(sv)) {
            c.warn(`${w}.${k}.${s}`, `"${sv}" has no unit — write "${sv}px".`, ref);
          }
        }
      }
    });
    return;
  }

  if (group === 'font' || group === 'bodyFont' || group === 'headingFont') {
    // font groups nest one more level: font.font.desktop.value.{…}
    // (bodyFont/headingFont: body.font / h1.font … — only check the plain case)
    if (group === 'font' && isObj(val)) {
      const top = Object.keys(val);
      const misplaced = top.filter(k => BREAKPOINTS.has(k));
      if (misplaced.length > 0) {
        c.err(where, `the font group nests one level deeper: ${where}.font.desktop.value.{color,size,weight,…} — you wrote ${where}.${misplaced[0]}.`, ref);
        return;
      }
      const inner = (val as Record<string, unknown>).font;
      if (isObj(inner)) {
        checkBreakpoints(`${where}.font`, inner, c, ref);
        eachValue(inner, (bp, state, v) => {
          if (!isObj(v)) {
            return;
          }
          for (const k of Object.keys(v)) {
            if (!FONT_KEYS.has(k)) {
              const alias = FONT_ALIASES[k];
              c.err(`${where}.font.${bp}.${state}.${k}`, alias ? `"${k}" is not a font key — Divi spells it "${alias}".` : `"${k}" is not a font key. Keys: ${fmtList(FONT_KEYS)}.`, ref);
            }
          }
        });
      }
    }
    return;
  }

  if (group === 'background') {
    eachValue(val, (bp, state, v) => {
      if (!isObj(v)) {
        c.err(`${where}.${bp}.${state}`, 'background value must be an object {color, image: {url}, gradient: {…}, …}.', ref);
        return;
      }
      const img = v.image;
      if (isObj(img) && typeof img.url === 'string') {
        stats.images++;
        checkMediaUrl(`${where}.${bp}.${state}.image.url`, img.url, c, opts);
      }
    });
    return;
  }

  void moduleName;
}

function checkInnerShape(moduleName: string, element: string, where: string, val: unknown, c: Collector, ref: string, stats: ValidationStats, opts: ValidateOptions): void {
  const shape = INNER_SHAPES[`${moduleName}:${element}`];
  eachValue(val, (bp, state, v) => {
    const w = `${where}.${bp}.${state}`;
    // Media anywhere in innerContent must live on the site.
    if (isObj(v)) {
      for (const k of ['src', 'url', 'srcWebm']) {
        const u = v[k];
        if (typeof u === 'string' && u) {
          if (k !== 'url' || element === 'portrait' || MEDIA_EXT_RE.test(u)) {
            stats.images++;
            checkMediaUrl(`${w}.${k}`, u, c, opts);
          }
        }
      }
    }
    if (!shape) {
      return;
    }
    if (shape === 'string' || shape === 'html') {
      if (typeof v !== 'string') {
        c.err(w, `${element} on ${moduleName} is a ${shape === 'html' ? 'HTML string' : 'plain string'}, not ${Array.isArray(v) ? 'an array' : typeof v}${isObj(v) ? ` (you wrote an object with ${fmtList(Object.keys(v))})` : ''}.`, ref);
      } else if (shape === 'string' && /<[a-z][^>]*>/i.test(v)) {
        c.warn(w, `${element} on ${moduleName} is plain text — HTML tags here are printed literally.`, ref);
      }
      return;
    }
    if (!isObj(v)) {
      c.err(w, `${element} on ${moduleName} is an OBJECT {${shape.keys.join(', ')}}, not ${typeof v}${typeof v === 'string' ? ` — write {"${shape.required[0] ?? shape.keys[0]}": ${JSON.stringify(v.slice(0, 40))}}` : ''}.`, ref);
      return;
    }
    for (const req of shape.required) {
      if (!(req in v)) {
        c.err(w, `${element} on ${moduleName} needs "${req}" (has ${fmtList(Object.keys(v)) || 'nothing'}).`, ref);
      }
    }
    for (const k of Object.keys(v)) {
      if (!shape.keys.includes(k)) {
        c.warn(`${w}.${k}`, `"${k}" is not a documented key of ${element} on ${moduleName} (documented: ${shape.keys.join(', ')}).`, ref);
      }
    }
  });
}

function checkMediaUrl(where: string, url: string, c: Collector, opts: ValidateOptions): void {
  let host: string;
  try {
    if (url.startsWith('/')) {
      return; // site-relative
    }
    host = new URL(url).hostname.toLowerCase();
  } catch {
    c.err(where, `"${url.slice(0, 80)}" is not a valid URL.`);
    return;
  }
  if (LIBRARY_HOST_RE.test(host)) {
    c.err(where, `${url.slice(0, 100)} is a workspace-library URL, not the site's. Upload it with wp_upload_media (or wp_media_upload) first and use the returned site URL — library links are private and are never pasted into a client site.`);
    return;
  }
  if (opts.siteHost) {
    const want = opts.siteHost.toLowerCase().replace(/^www\./, '');
    const got = host.replace(/^www\./, '');
    if (got !== want) {
      c.err(where, `${url.slice(0, 100)} is hosted on ${host}, not on this site (${opts.siteHost}). Hot-linked media breaks when the source changes and is blocked by many hosts — upload it to the site's media library first and use that URL.`);
    }
  }
}

/** Render issues for the model: errors first, each with the reference to read. */
export function formatValidation(r: ValidationResult, toolName: string): string {
  const lines: string[] = [];
  if (!r.ok) {
    lines.push(`[refused] ${toolName} was NOT sent to the site — the Divi markup failed validation with ${r.errors.length} error(s). Nothing was written. Fix every item below, then call the tool again.`);
    const consult = new Set<string>();
    for (const e of r.errors.slice(0, 40)) {
      lines.push(`  ✗ ${e.where}: ${e.message}`);
      if (e.consult) {
        consult.add(e.consult);
      }
    }
    if (r.errors.length > 40) {
      lines.push(`  … and ${r.errors.length - 40} more.`);
    }
    if (consult.size > 0) {
      lines.push(`Read the vendor maps before rewriting: ${[...consult].map(m => `diviops_reference {module:"${m}"}`).join(' · ')}. Do not guess attribute paths — every path must appear in the module's map.`);
    }
  }
  if (r.warnings.length > 0) {
    lines.push(`${r.ok ? '' : '\n'}Warnings (${r.warnings.length}):`);
    for (const w of r.warnings.slice(0, 20)) {
      lines.push(`  ⚠ ${w.where}: ${w.message}`);
    }
  }
  return lines.join('\n');
}
