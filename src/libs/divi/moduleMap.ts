/**
 * Divi 5 module schema, derived from the vendored DiviOps reference (Phase 47).
 *
 * `module-formats.md` carries one GENERATED block per Divi 5 module — the
 * element names each module accepts and, per element, the decoration groups
 * it renders, whether it takes innerContent and whether it has an `advanced`
 * bag. That is the machine-readable half of the "111 module maps"; this file
 * turns it into a schema the validator can check block JSON against, so an
 * attribute path the model invented (`module.decoration.font` on a Heading,
 * `src` at the top level of an Image) is refused BEFORE it reaches a site
 * instead of rendering as nothing.
 *
 * The schema is loaded once per process from the same folder that backs
 * `diviops_reference`, so the two can never disagree. If the folder is
 * missing on a deployment the loader throws — and the write gate fails
 * CLOSED (no schema → no Divi writes), never open.
 */

import fs from 'node:fs';
import path from 'node:path';

export type ElementSpec = {
  /** decoration group names, e.g. "font", "spacing", "background" */
  groups: Set<string>;
  innerContent: boolean;
  advanced: boolean;
};

export type ModuleSpec = {
  /** "divi/blurb" */
  name: string;
  tier: string;
  elements: Map<string, ElementSpec>;
};

export type ModuleSchema = {
  modules: Map<string, ModuleSpec>;
  /** Where the schema came from, for messages. */
  source: string;
};

/** Keys every block may carry at the top level, alongside its elements. */
export const UNIVERSAL_BLOCK_KEYS = new Set(['builderVersion', 'modulePreset', 'groupPreset', 'locked', 'css', 'dynamicOptionGroups']);

/** Sub-keys an element may carry. `meta` is only meaningful on `module`. */
export const ELEMENT_SUBKEYS = new Set(['decoration', 'advanced', 'innerContent', 'meta']);

/** Blocks that contain other blocks rather than rendering content themselves. */
export const STRUCTURAL = new Set(['divi/placeholder', 'divi/section', 'divi/row', 'divi/row-inner', 'divi/column', 'divi/column-inner', 'divi/group', 'divi/group-carousel']);

/** Child item → the only parent it may live in. */
export const ITEM_PARENT: Record<string, string[]> = {
  'divi/accordion-item': ['divi/accordion'],
  'divi/tab': ['divi/tabs'],
  'divi/slide': ['divi/slider', 'divi/fullwidth-slider'],
  'divi/pricing-table': ['divi/pricing-tables'],
  'divi/counter': ['divi/counters'],
  'divi/icon-list-item': ['divi/icon-list'],
  'divi/timeline-item': ['divi/timeline'],
  'divi/contact-field': ['divi/contact-form'],
  'divi/signup-custom-field': ['divi/signup'],
  'divi/social-media-follow-network': ['divi/social-media-follow'],
  'divi/video-slider-item': ['divi/video-slider'],
  'divi/map-pin': ['divi/map', 'divi/fullwidth-map'],
};

/** Parents that hold item children (derived from ITEM_PARENT). */
export const ITEM_PARENTS = new Set(Object.values(ITEM_PARENT).flat());

const GEN_RE = /<!-- BEGIN GENERATED:module:(divi\/[a-z0-9-]+) -->([\s\S]*?)<!-- END GENERATED:module:\1 -->/g;
const TIER_RE = /<!-- TIER: ([a-z]+) -->/;
const ELEMENT_LINE_RE = /^- \*\*(\w+)\*\* — (.*)$/;
const GROUP_RE = /`\w+\.decoration\.(\w+)`/g;

/** Parse the GENERATED module blocks out of module-formats.md. Exported for tests. */
export function parseModuleSchema(markdown: string, source = 'module-formats.md'): ModuleSchema {
  const modules = new Map<string, ModuleSpec>();
  for (const m of markdown.matchAll(GEN_RE)) {
    const name = m[1]!;
    const body = m[2]!;
    const tier = TIER_RE.exec(body)?.[1] ?? 'free';
    const elements = new Map<string, ElementSpec>();
    for (const raw of body.split('\n')) {
      const line = ELEMENT_LINE_RE.exec(raw.trim());
      if (!line) {
        continue;
      }
      const elem = line[1]!;
      const rest = line[2]!;
      const groups = new Set<string>();
      for (const g of rest.matchAll(GROUP_RE)) {
        groups.add(g[1]!);
      }
      elements.set(elem, {
        groups,
        innerContent: /\+innerContent/.test(rest),
        advanced: /\+advanced/.test(rest),
      });
    }
    if (elements.size > 0) {
      modules.set(name, { name, tier, elements });
    }
  }
  return { modules, source };
}

let cached: ModuleSchema | null = null;

/**
 * Load the schema from the vendored skill. `dir` is relative to the app root
 * (same convention as ReferenceSpec.dir). Throws when the file is absent —
 * callers must treat that as "refuse the write", not "skip validation".
 */
export function loadModuleSchema(file = 'vendor/diviops-skill/divi-5-builder/references/module-formats.md'): ModuleSchema {
  if (cached) {
    return cached;
  }
  const p = path.join(process.cwd(), file);
  if (!fs.existsSync(p)) {
    throw new Error(`Divi module schema is not present on this deployment (${file}); Divi writes are refused until it is.`);
  }
  const schema = parseModuleSchema(fs.readFileSync(p, 'utf8'), file);
  if (schema.modules.size < 50) {
    throw new Error(`Divi module schema at ${file} parsed only ${schema.modules.size} modules — refusing to validate against a partial map.`);
  }
  cached = schema;
  return schema;
}

/** Test hook. */
export function resetModuleSchemaCache(): void {
  cached = null;
}

/** "divi/icon-list-item" → "Icon List Item" (the name diviops_reference answers to). */
export function referenceNameFor(moduleName: string): string {
  return moduleName
    .replace(/^divi\//, '')
    .split('-')
    .map(w => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Normalise any spelling ("Blurb", "divi/blurb", "blurb module") to "divi/blurb". */
export function canonicalModuleName(input: string): string {
  const s = input.trim().toLowerCase().replace(/^divi\//, '').replace(/\bmodule\b/g, '').trim().replace(/[\s_]+/g, '-');
  return `divi/${s}`;
}
