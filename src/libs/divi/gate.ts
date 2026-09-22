/**
 * DiviOps write gate (Phase 47) — everything that stands between the model
 * and a client's Divi site, in order:
 *
 *   1. tool tiering      — which DiviOps tools a surface may call at all
 *                          (a site's own chat gets page/section/module tools,
 *                          never theme-builder, presets, variables, canvases)
 *   2. markup validation — validator.ts against the vendor module maps
 *   3. reference ledger  — every module type in the write must have been
 *                          looked up in diviops_reference by this conversation
 *   4. budgets           — writes per turn, blocks per write, bytes per write
 *   5. module_update     — dot-path writes get the same path rules
 *
 * A refusal is returned as TEXT (never thrown): the model reads it as the
 * tool's answer and fixes its input. Nothing was sent to the site.
 */

import { bumpCounter, currentTurn } from '@/libs/agent/turnContext';
import { parseDiviBlocks, serializeDiviBlocks } from './blocks';
import { unconsulted } from './consulted';
import { loadModuleSchema, referenceNameFor, STRUCTURAL } from './moduleMap';
import { formatValidation, validateDiviMarkup } from './validator';

export type GateResult = {
  args: Record<string, unknown>;
  /** Appended to the tool result on success. */
  note?: string;
  /** When set, the tool is NOT called; this text is the result the model sees. */
  refuse?: string;
};

export type GateContext = {
  /** Target site URL (post site-binding). */
  target: string;
  connectionName: string;
};

/** Tools whose `content` is whole-page or section block markup. */
export const DIVI_MARKUP_WRITES: Record<string, { arg: string; placeholder: 'required' | 'forbidden' | 'any' }> = {
  diviops_page_create: { arg: 'content', placeholder: 'required' },
  diviops_page_update_content: { arg: 'content', placeholder: 'required' },
  diviops_section_append: { arg: 'content', placeholder: 'forbidden' },
  diviops_section_replace: { arg: 'content', placeholder: 'forbidden' },
  diviops_library_save: { arg: 'content', placeholder: 'any' },
  diviops_tb_layout_update: { arg: 'content', placeholder: 'any' },
  diviops_canvas_create: { arg: 'content', placeholder: 'any' },
  diviops_canvas_update: { arg: 'content', placeholder: 'any' },
};

/** Every DiviOps tool that mutates the site (for budgets and audit). */
export const DIVI_WRITE_RE = /^diviops_(?:page_(?:create|update_content|update_status|trash)|section_(?:append|replace|remove)|module_(?:update|move|clone|lock|unlock)|preset_(?:cleanup|create|reassign|update|delete|set_default)|library_save|tb_(?:layout_update|template_create|template_trash)|canvas_(?:create|duplicate|update|delete)|variable_(?:create|create_fluid_system|delete)|global_(?:color|font)_(?:create|update|delete)|meta_flush_cache|rollback_snapshot_restore)$/;

/**
 * What a SITE's own admin may drive from its chat (Phase 46 surface). Page
 * content and the page-scoped cache flush — nothing that changes the theme,
 * the design system, presets, variables or other pages' templates. Those are
 * agency operations and stay in the operator workspace.
 */
const SITE_SURFACE_ALLOW_RE = /^diviops_(?:meta_(?:ping|info|find_icon|flush_cache)|page_(?:list|get|get_layout|create|update_content|update_status|trash)|section_(?:get|append|replace|remove)|module_(?:update|move|clone)|schema_(?:list_modules|get_module|get_settings)|global_(?:color|font)_list|template_(?:list|get)|library_(?:list|get)|render_preview|validate_blocks|variable_list|rollback_snapshot_restore)$/;

export function isSiteSurfaceDiviToolAllowed(toolName: string): boolean {
  return SITE_SURFACE_ALLOW_RE.test(toolName);
}

const MAX_MARKUP_WRITES_PER_TURN = { operator: 20, site: 6 } as const;
const MAX_WRITES_PER_TURN = { operator: 60, site: 12 } as const;

/** Decoration groups that exist on SOME element of SOME module (for module_update path checks). */
let knownGroups: Set<string> | null = null;
function allGroups(): Set<string> {
  if (knownGroups) {
    return knownGroups;
  }
  const s = new Set<string>();
  for (const m of loadModuleSchema().modules.values()) {
    for (const e of m.elements.values()) {
      for (const g of e.groups) {
        s.add(g);
      }
    }
  }
  knownGroups = s;
  return s;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The gate. Pure over its inputs plus the turn context; safe to call for
 * every DiviOps tool (non-write tools pass straight through).
 */
export function diviWriteGate(toolName: string, args: Record<string, unknown>, ctx: GateContext): GateResult {
  const turn = currentTurn();
  const surface = turn?.surface ?? 'site';

  // 1. Surface tiering — a site's chat never reaches agency-level tools.
  if (surface === 'site' && toolName.startsWith('diviops_') && !isSiteSurfaceDiviToolAllowed(toolName)) {
    return {
      args,
      refuse: `[refused] ${toolName} is not available from a site's chat — it changes the theme, design system, presets or templates, which are managed by the agency. Tell the owner the request has been noted for the agency team (report_issue if it blocks them). Page content tools (page_*, section_*, module_update/move/clone) are available.`,
    };
  }
  if (surface === 'site' && toolName === 'diviops_meta_flush_cache' && !args.post_id) {
    return { args, refuse: '[refused] from a site\'s chat, diviops_meta_flush_cache must name the page: pass post_id. Site-wide flushes (all / after) are an agency operation.' };
  }

  // 4a. Write budget per turn.
  if (DIVI_WRITE_RE.test(toolName) && !args.dry_run) {
    const n = bumpCounter('divi.writes');
    if (n > MAX_WRITES_PER_TURN[surface]) {
      return { args, refuse: `[refused] this turn has already made ${n - 1} Divi writes (limit ${MAX_WRITES_PER_TURN[surface]}). Stop, report what is done and what is left, and continue on the owner's next message.` };
    }
  }

  // 5. module_update: dot-path writes.
  if (toolName === 'diviops_module_update' && args.attrs && typeof args.attrs === 'object' && !Array.isArray(args.attrs)) {
    const bad: string[] = [];
    const groups = allGroups();
    for (const [pathKey, value] of Object.entries(args.attrs as Record<string, unknown>)) {
      const parts = pathKey.split(/(?<!\\)\./);
      const [elem, sub, third] = parts;
      if (!elem || !sub) {
        bad.push(`"${pathKey}": must be a dotted path starting with an element (module.decoration.spacing.desktop.value.padding.top).`);
        continue;
      }
      if (['builderVersion', 'modulePreset', 'groupPreset', 'locked', 'css'].includes(elem)) {
        continue;
      }
      if (!['decoration', 'advanced', 'innerContent', 'meta'].includes(sub)) {
        bad.push(`"${pathKey}": "${sub}" must be decoration, advanced, innerContent or meta.`);
        continue;
      }
      if (sub === 'decoration' && third && !groups.has(third)) {
        const alias: Record<string, string> = { padding: 'spacing', margin: 'spacing', color: 'background', fontSize: 'font', fontWeight: 'font', width: 'sizing', height: 'sizing' };
        bad.push(`"${pathKey}": "${third}" is not a decoration group${alias[third] ? ` — did you mean ${elem}.decoration.${alias[third]}` : ''}. Groups: ${[...groups].sort().join(', ')}.`);
        continue;
      }
      if (sub === 'decoration' && third === 'spacing' && /\.(?:padding|margin)$/.test(pathKey) && typeof value !== 'object') {
        bad.push(`"${pathKey}": padding/margin take an object of sides {top,right,bottom,left}, not ${JSON.stringify(value)}.`);
      }
      if (sub === 'decoration' && third === 'font' && parts.length > 3 && parts[3] !== 'font') {
        bad.push(`"${pathKey}": the font group nests one level deeper — ${elem}.decoration.font.font.desktop.value.{color,size,weight,…}.`);
      }
      if (/\.(?:fontSize|fontWeight|fontFamily)$/.test(pathKey)) {
        bad.push(`"${pathKey}": Divi spells these size / weight / family.`);
      }
    }
    if (bad.length > 0) {
      return { args, refuse: `[refused] diviops_module_update was NOT sent — ${bad.length} attribute path(s) are not valid Divi 5 paths:\n${bad.map(b => `  ✗ ${b}`).join('\n')}\nRead diviops_reference {module:"<the module you are editing>"} and use only paths from its map.` };
    }
  }

  // 2–4. Markup writes.
  const spec = DIVI_MARKUP_WRITES[toolName];
  if (!spec) {
    return { args };
  }
  const markup = args[spec.arg];
  if (typeof markup !== 'string') {
    return { args }; // the server rejects a missing/non-string content itself
  }

  let schema;
  try {
    schema = loadModuleSchema();
  } catch (err) {
    return { args, refuse: `[refused] ${err instanceof Error ? err.message : 'Divi module schema unavailable'} — this is a platform configuration fault; call report_issue and tell the owner the write could not be made.` };
  }

  const result = validateDiviMarkup(markup, { schema, placeholder: spec.placeholder, siteHost: hostOf(ctx.target) });
  if (!result.ok) {
    return { args, refuse: formatValidation(result, toolName) };
  }

  // 3. Reference ledger — no module written without its map having been read.
  const used = Object.keys(result.stats.modules).filter(m => !STRUCTURAL.has(m));
  if (used.length > 0) {
    if (!turn) {
      return { args, refuse: '[refused] Divi writes can only run inside a conversation turn (no turn context) — this is a platform fault; call report_issue.' };
    }
    const missing = unconsulted(turn.conversationId, used);
    if (missing.length > 0) {
      return {
        args,
        refuse: `[refused] ${toolName} was NOT sent — this conversation has not read the reference map for: ${missing.map(m => `${m} → diviops_reference {module:"${referenceNameFor(m)}"}`).join(' · ')}. Read each map (one call per module), rebuild the markup from the documented element paths, then call ${toolName} again. Never write a module from memory.`,
      };
    }
  }

  if (!args.dry_run) {
    const n = bumpCounter('divi.markupWrites');
    if (n > MAX_MARKUP_WRITES_PER_TURN[surface]) {
      return { args, refuse: `[refused] this turn has already written ${n - 1} page/section payloads (limit ${MAX_MARKUP_WRITES_PER_TURN[surface]}). Report progress and continue on the next message.` };
    }
  }

  // Canonical form: the model may write plain JSON with ordinary HTML; the
  // platform applies WordPress's block-attribute escaping so nothing inside
  // an attribute can end the comment early. Same tree, byte-safe output.
  const tree = parseDiviBlocks(markup);
  const normalised = tree.errors.length === 0 ? serializeDiviBlocks(tree.roots) : markup;
  const outArgs = normalised === markup ? args : { ...args, [spec.arg]: normalised };

  const summary = `[validated] ${result.stats.blocks} blocks · ${Object.entries(result.stats.modules).map(([k, v]) => `${k.replace(/^divi\//, '')}×${v}`).join(', ') || 'structure only'}${result.stats.images ? ` · ${result.stats.images} site-hosted image(s)` : ''}`;
  const warnings = result.warnings.length > 0 ? `\n${formatValidation(result, toolName)}` : '';
  return { args: outArgs, note: `${summary}${warnings}` };
}
