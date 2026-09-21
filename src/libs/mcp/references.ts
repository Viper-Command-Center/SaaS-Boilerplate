/**
 * Reference libraries for bundled stdio servers (Phase 45).
 *
 * A vendor's client-side "skill" is knowledge the agent would otherwise never
 * see: DiviOps' divi-5-builder is ~400 KB of verified attribute paths, preset
 * rules and design patterns, and its own README says that without it "agents
 * guess attr formats and produce broken pages". It cannot ride in the system
 * prompt (playbooks cap at 12 KB; the cached prefix must stay small), so it is
 * served ON DEMAND: one meta-tool per server (`diviops_reference`) that returns
 * the index, one module's element map, one heading's section, or a keyword
 * search — always bounded.
 *
 * Pure parsing lives here so it is unit-testable without the filesystem; the
 * library is loaded lazily and cached per process (files change only on deploy).
 */

import fs from 'node:fs';
import path from 'node:path';

export type RefSection = {
  /** File path relative to the library root, e.g. "divi-5-builder/references/module-formats.md". */
  file: string;
  /** Heading depth: 1..4. */
  level: number;
  /** Heading text with the trailing "*(VB-verified …)*" note stripped. */
  title: string;
  /** The raw verification note, when present. */
  note?: string;
  /** "Tier 3 — Module Reference (element maps) > Content Modules > Text" */
  crumbs: string;
  /** Body text up to the next heading of the same or higher level. */
  body: string;
};

export type ReferenceSpec = {
  /** Directory relative to process.cwd() holding the vendored skill files. */
  dir: string;
  /** Tool name registered for the model, e.g. "diviops_reference". */
  toolName: string;
  /** One paragraph for the tool description — what is in here and when to call it. */
  description: string;
  /** Which file holds the per-module maps looked up by `module`. */
  moduleFile: string;
  /** Heading level of a module entry in moduleFile (DiviOps: "#### Text"). */
  moduleLevel: number;
};

export const MAX_REFERENCE_CHARS = 14_000;
const SEARCH_HITS = 5;
const SEARCH_SNIPPET = 2_400;

const HEADING_RE = /^(#{1,4}) (\S[^\n]*)$/;
const NOTE_RE = /\s*\*\((.+?)\)\*\s*$/;

/** Split one markdown file into heading-delimited sections. Pure. */
export function parseSections(file: string, text: string): RefSection[] {
  const lines = text.split(/\r?\n/);
  const out: RefSection[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let current: RefSection | null = null;
  let inFence = false;
  const bodyLines: string[] = [];

  const flush = () => {
    if (current) {
      current.body = bodyLines.join('\n').trim();
      out.push(current);
    }
    bodyLines.length = 0;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
    }
    const m = !inFence ? HEADING_RE.exec(line) : null;
    if (!m) {
      bodyLines.push(line);
      continue;
    }
    flush();
    const level = m[1]!.length;
    let title = m[2]!.trim();
    let note: string | undefined;
    const n = NOTE_RE.exec(title);
    if (n) {
      note = n[1];
      title = title.replace(NOTE_RE, '').trim();
    }
    title = title.replace(/`/g, '');
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
      stack.pop();
    }
    stack.push({ level, title });
    // The H1 is the file's own title — leave it out of the breadcrumb.
    current = { file, level, title, note, crumbs: stack.filter(s => s.level > 1).map(s => s.title).join(' > ') || title, body: '' };
  }
  flush();
  return out;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Trim to the budget with a stated reason — never a silent cut. */
export function bounded(text: string, limit = MAX_REFERENCE_CHARS): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n\n[… truncated at ${limit} characters — ask for a narrower section (file + section) to see the rest]`;
}

export class ReferenceLibrary {
  readonly sections: RefSection[];
  readonly files: string[];

  constructor(readonly spec: ReferenceSpec, docs: Array<{ file: string; text: string }>) {
    this.files = docs.map(d => d.file);
    this.sections = docs.flatMap(d => parseSections(d.file, d.text));
  }

  /** Module entries: headings at moduleLevel inside moduleFile. */
  modules(): RefSection[] {
    return this.sections.filter(s => s.file === this.spec.moduleFile && s.level === this.spec.moduleLevel);
  }

  /** The index the model sees with no arguments. */
  index(): string {
    const byFile = new Map<string, RefSection[]>();
    for (const s of this.sections) {
      byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
    }
    const lines: string[] = [`${this.spec.toolName} — vendor reference library (${this.files.length} files, ${this.sections.length} sections).`, ''];
    for (const [file, secs] of byFile) {
      const h2 = secs.filter(s => s.level <= 2).map(s => s.title).slice(0, 14);
      lines.push(`• ${file}${h2.length ? ` — ${h2.join(' · ')}` : ''}`);
    }
    const mods = this.modules().map(m => m.title);
    lines.push('', `Module maps (${mods.length}; pass module:"<name>"): ${mods.join(', ')}`);
    lines.push('', 'Usage: {module:"Blurb"} → that module\'s element map + its minimal snippet · {file, section} → one heading (section may be a prefix; crumbs like "Tier 1 > Gradient background" work) · {query:"hover padding"} → top matches. Everything is truncated to a budget; ask narrower rather than wider.');
    return lines.join('\n');
  }

  /** One module's element map, plus its minimal snippet when one exists. */
  module(name: string): string | null {
    const want = norm(name).replace(/\bmodule\b/g, '').trim();
    if (!want) {
      return null;
    }
    const mods = this.modules();
    const hit = mods.find(m => norm(m.title) === want)
      ?? mods.find(m => norm(m.title).startsWith(want))
      ?? mods.find(m => norm(m.title).includes(want));
    if (!hit) {
      return null;
    }
    const parts = [`## ${hit.crumbs}${hit.note ? `  *(${hit.note})*` : ''}`, hit.body];
    // A minimal, copy-ready snippet for the same module, if the bundle has one.
    const snippet = this.sections.find(s => /minimal-snippets/.test(s.file) && s.level >= 2 && norm(s.title).includes(norm(hit.title)));
    if (snippet) {
      parts.push('', `## Minimal snippet (${snippet.file} > ${snippet.crumbs})`, snippet.body);
    }
    return bounded(parts.join('\n'));
  }

  /** One heading by file + title (prefix / crumb match). */
  section(file: string, title: string): string | null {
    const f = norm(file);
    const t = norm(title);
    const inFile = this.sections.filter(s => norm(s.file).includes(f));
    if (inFile.length === 0) {
      return null;
    }
    const hit = inFile.find(s => norm(s.title) === t)
      ?? inFile.find(s => norm(s.crumbs) === t)
      ?? inFile.find(s => norm(s.title).startsWith(t))
      ?? inFile.find(s => norm(s.crumbs).includes(t));
    if (!hit) {
      return null;
    }
    // Include child headings so "Tier 1" returns the whole tier, bounded.
    const idx = this.sections.indexOf(hit);
    const children: string[] = [];
    for (let i = idx + 1; i < this.sections.length; i++) {
      const s = this.sections[i]!;
      if (s.file !== hit.file || s.level <= hit.level) {
        break;
      }
      children.push(`${'#'.repeat(s.level)} ${s.title}${s.note ? ` *(${s.note})*` : ''}\n${s.body}`);
    }
    return bounded([`## ${hit.file} > ${hit.crumbs}${hit.note ? `  *(${hit.note})*` : ''}`, hit.body, ...children].join('\n\n'));
  }

  /** Keyword search: score = title hits ×3 + body hits, top N with snippets. */
  search(query: string): string {
    const terms = norm(query).split(' ').filter(t => t.length > 1);
    if (terms.length === 0) {
      return 'query is empty.';
    }
    const scored = this.sections
      .map((s) => {
        const title = norm(`${s.crumbs} ${s.title}`);
        const body = s.body.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (title.includes(t)) {
            score += 3;
          }
          const n = body.split(t).length - 1;
          score += Math.min(n, 5);
        }
        return { s, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, SEARCH_HITS);
    if (scored.length === 0) {
      return `No section mentions "${query}". Try a module name (module:"…") or a broader word.`;
    }
    const out = scored.map(({ s }) => {
      const body = s.body.length > SEARCH_SNIPPET ? `${s.body.slice(0, SEARCH_SNIPPET)}\n[… more — request {file:"${s.file}", section:"${s.title}"}]` : s.body;
      return `## ${s.file} > ${s.crumbs}\n${body}`;
    });
    return bounded(out.join('\n\n---\n\n'));
  }

  /** The tool entrypoint. */
  lookup(args: { module?: unknown; file?: unknown; section?: unknown; query?: unknown }): string {
    const moduleName = typeof args.module === 'string' ? args.module.trim() : '';
    const file = typeof args.file === 'string' ? args.file.trim() : '';
    const section = typeof args.section === 'string' ? args.section.trim() : '';
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (moduleName) {
      return this.module(moduleName) ?? `No module map named "${moduleName}". Available: ${this.modules().map(m => m.title).join(', ')}.`;
    }
    if (file && section) {
      return this.section(file, section) ?? `No heading matching "${section}" in ${file}. Call with no arguments for the index.`;
    }
    if (file) {
      const secs = this.sections.filter(s => norm(s.file).includes(norm(file)));
      if (secs.length === 0) {
        return `No file matching "${file}". Files: ${this.files.join(', ')}.`;
      }
      return bounded(`${secs[0]!.file} — headings:\n${secs.map(s => `${'  '.repeat(Math.max(0, s.level - 1))}- ${s.title}${s.note ? ` *(${s.note})*` : ''}`).join('\n')}\n\nPass section:"<heading>" to read one.`);
    }
    if (query) {
      return this.search(query);
    }
    return this.index();
  }
}

// ─── Loading ─────────────────────────────────────────────────────────────────

const cache = new Map<string, ReferenceLibrary>();

function walk(dir: string, root: string, out: Array<{ file: string; text: string }>) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p, root, out);
    } else if (entry.isFile() && /\.md$/i.test(entry.name) && entry.name.toLowerCase() !== 'readme.md') {
      out.push({ file: path.relative(root, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
    }
  }
}

/** Load (once per process) the library described by `spec`. Throws a plain message if the folder is missing. */
export function loadReferenceLibrary(spec: ReferenceSpec): ReferenceLibrary {
  const hit = cache.get(spec.toolName);
  if (hit) {
    return hit;
  }
  const root = path.join(process.cwd(), spec.dir);
  if (!fs.existsSync(root)) {
    throw new Error(`${spec.toolName}: reference folder ${spec.dir} is not present on this deployment.`);
  }
  const docs: Array<{ file: string; text: string }> = [];
  walk(root, root, docs);
  docs.sort((a, b) => a.file.localeCompare(b.file));
  const lib = new ReferenceLibrary(spec, docs);
  cache.set(spec.toolName, lib);
  return lib;
}
