/**
 * Allowlist of stdio MCP servers this platform can spawn.
 *
 * 🔴 THIS FILE IS THE SECURITY BOUNDARY for the stdio transport.
 * A stdio connection stores only a KEY into this table (in
 * pluginCatalog.provider). The executable is resolved here, from packages
 * pinned in OUR package.json — never from user input. Adding a server to
 * Artivio = add the npm dependency + one entry here. Nothing a workspace
 * owner types can ever become a spawned command.
 *
 * Env is built per-connection from two safe inputs:
 *   target      — the connection's url field (e.g. the client's site URL)
 *   credential  — the single vault-sealed secret the workspace pasted
 * buildEnv decides how those map onto the server's environment variables.
 */

import type { ReferenceSpec } from '@/libs/mcp/references';
import { createRequire } from 'node:module';
import { diviWriteGate } from '@/libs/divi/gate';
import { diviRenderCheck } from '@/libs/divi/renderCheck';
import { loadReferenceLibrary } from '@/libs/mcp/references';

export type StdioServerSpec = {
  /** Allowlist key. Stored in pluginCatalog.provider for stdio entries. */
  key: string;
  name: string;
  /**
   * All current stdio servers are per-connection (each workspace brings its
   * own target + credential, like the WordPress built-in). A future platform-
   * credential stdio server would add tier-1 handling in the plugins route.
   */
  perConnection: true;
  /** Shown next to the credential field when enabling. */
  credentialLabel: string;
  /** Shown next to the site/target field when enabling. */
  targetLabel: string;
  /**
   * Resolve the absolute path of the server's entry script. Throws if the
   * package isn't installed — surfaced as a failedConnection, never a crash.
   */
  resolveEntry: () => string;
  /** Map (target, decrypted credential) → the child process env. */
  buildEnv: (target: string, credential: string) => Record<string, string>;
  /**
   * Standing guidance for the model, appended to the system prompt under
   * "How your connected tools actually behave" (same slot built-in providers
   * use). For a bundled server whose vendor ships a client-side skill the
   * agent would otherwise never see (DiviOps' `divi-5-builder`), this is
   * where the load-bearing rules from that skill live. Keep it to the rules
   * that cause SILENT failures — a wrong rule is worse than none.
   */
  guidance?: string;
  /**
   * Optional pre-call guard, run in-process BEFORE the call is forwarded to
   * the child. Same role as the adapter-level guardrails in the Cloudflare and
   * Postgres built-ins: fix what can be fixed mechanically, refuse what will
   * silently corrupt, and say why in words the model can act on. Returns the
   * (possibly rewritten) args plus an optional note appended to the result.
   * Set `refuse` to answer the model WITHOUT calling the server (Phase 47) —
   * a refusal is a tool decision, never a thrown "platform" error.
   */
  guardCall?: (toolName: string, args: Record<string, unknown>, ctx: GuardContext) => GuardResult;
  /**
   * Optional post-call hook (Phase 47): runs after a SUCCESSFUL call with the
   * raw result text and a way to call sibling tools on the same server. Used
   * for the Divi render check — a page write is followed by a render of the
   * saved page so the model reports what the site shows, not what it sent.
   * Returns text to append to the result, or undefined.
   */
  afterCall?: (toolName: string, args: Record<string, unknown>, resultText: string, callTool: (name: string, a: Record<string, unknown>) => Promise<string>, ctx: GuardContext) => Promise<string | undefined>;
  /**
   * Phase 45: the vendor's full client-side skill, vendored under `dir` and
   * served on demand through ONE meta-tool (`toolName`). Registered once per
   * server key however many connections use it. See references.ts.
   */
  references?: ReferenceSpec;
  /**
   * The length of THIS server's longest tool name (sanitized). Used at
   * connection-creation time to reject a connection name so long that the
   * `mcp__<name>__<tool>` wrapper would push the longest tool past the model
   * API's 64-char limit — the failure that made a whole DiviOps connection
   * look "down" (its longest tools silently dropped, then the request 400d).
   * Set it once here so the routes don't have to spawn the server to find out.
   * DiviOps' longest is `diviops_variable_create_fluid_system` (36).
   */
  maxToolNameLen?: number;
};

export type GuardContext = { target: string; connectionName: string };
export type GuardResult = {
  args: Record<string, unknown>;
  note?: string;
  /** Set → the tool is NOT called; this is the result the model reads. */
  refuse?: string;
};

// ─── DiviOps guardrails ───────────────────────────────────────────────────────
// Both traps below were read from the diviops-agent WordPress plugin source
// (trait-page.php / trait-core.php, plugin 1.5.16, 2026-09-04). They are the
// reason an agent's `section_replace` "fails on pages it already wrote" and
// why replaced pages came back blank. Neither is fixable from our transport —
// the matching and the write happen on the client's site — so we guard here.

/**
 * The plugin re-serializes every block's attrs on write with WordPress's
 * serialize_block_attributes(), which rewrites these characters into JSON
 * unicode escapes (`&` → `&`, `--` → `--`, …). But the plugin's
 * section-by-label lookup is a RAW SUBSTRING search for the unescaped label,
 * so a label containing any of them can never be matched again after the
 * first write. `match_text` searches the same escaped bytes and has the same
 * problem for any HTML in module attrs.
 */
const DIVI_UNMATCHABLE_RE = /[&<>"]|--/;
const DIVI_SECTION_TARGETING_TOOLS = new Set([
  'diviops_section_replace',
  'diviops_section_remove',
  'diviops_section_get',
]);
const DIVI_PLACEHOLDER_OPEN = /^\s*<!--\s*wp:divi\/placeholder\s*-->\s*/;
const DIVI_PLACEHOLDER_CLOSE = /\s*<!--\s*\/wp:divi\/placeholder\s*-->\s*$/;
const DIVI_ADMIN_LABEL_RE = /"adminLabel":\{"desktop":\{"value":"([^"]*)"/g;

/**
 * DiviOps' own WP-CLI passthrough needs `WP_PATH` (a Local by Flywheel install
 * on THIS machine) or `WP_CLI_CMD` (an ssh binary + key file) in the child
 * env. Neither exists on the platform, so the tool always answers
 * `meta_wp_cli.not_configured` — and the agent's next move was to ask the
 * owner for env vars that cannot be set (2026-09-05). WP-CLI lives in the
 * `wpcli` built-in (SSH via ssh2, per-connection key); say so instead.
 */
const DIVI_WP_CLI_TOOLS = new Set(['diviops_meta_wp_cli', 'diviops_scf_status', 'diviops_scf_export', 'diviops_scf_import', 'diviops_scf_sync', 'diviops_scf_field_group_list', 'diviops_scf_field_group_get']);

export function diviopsGuard(toolName: string, args: Record<string, unknown>, ctx: GuardContext): GuardResult {
  const out: Record<string, unknown> = { ...args };
  const notes: string[] = [];

  if (DIVI_WP_CLI_TOOLS.has(toolName)) {
    return refuse(
      `${toolName} is not available on this platform — DiviOps' WP-CLI passthrough needs a local WordPress install (WP_PATH) and there is none here; no environment variable or connection setting can enable it, so do not ask the owner for WP_PATH or WP_CLI_CMD. WP-CLI runs through the "wp-sites" connection (WordPress Sites: wp_cli, wp_cache_flush, wp_search_replace, wp_snapshot — pass the site label) or, on older workspaces, the legacy "wpcli" connection (wp_status, wp_cli…). If neither is in your list, the workspace owner needs to enable "WordPress Sites" in the Tools panel and add the site with its SSH details (or click Enable on the connection row if it is disabled).`,
    );
  }

  if (DIVI_SECTION_TARGETING_TOOLS.has(toolName)) {
    for (const field of ['label', 'match_text'] as const) {
      const value = out[field];
      if (typeof value === 'string' && DIVI_UNMATCHABLE_RE.test(value)) {
        return refuse(
          `${toolName}: the ${field} "${value}" contains a character (& < > " or --) that the DiviOps plugin stores as a JSON unicode escape, so its section lookup can never match it — this is a known plugin limitation, not a wrong page id. Target the section with match_text using a distinctive plain phrase from its content (letters, digits, spaces only), or rebuild it: diviops_section_append the new section, then diviops_section_remove the old one by a plain phrase.`,
        );
      }
    }
  }

  // section_append strips an incoming `divi/placeholder` wrapper and re-wraps
  // the page; section_replace splices `content` in VERBATIM. Following the
  // vendor's own "always wrap in divi/placeholder" rule therefore nests a
  // placeholder inside the page's placeholder, and Divi 5 renders nothing.
  if (toolName === 'diviops_section_replace' && typeof out.content === 'string') {
    const stripped = out.content.replace(DIVI_PLACEHOLDER_OPEN, '').replace(DIVI_PLACEHOLDER_CLOSE, '');
    if (stripped !== out.content) {
      out.content = stripped;
      notes.push('Note: the divi/placeholder wrapper was removed from `content` before the replace — section_replace splices the section in verbatim, and a nested placeholder renders the page blank.');
    }
  }

  // A label with unmatchable characters is legal Divi, but it becomes a
  // section nobody can address later. Warn on the way in rather than fail on
  // the way out.
  if ((toolName === 'diviops_section_append' || toolName === 'diviops_section_replace') && typeof out.content === 'string') {
    const labels = [...out.content.matchAll(DIVI_ADMIN_LABEL_RE)].map(m => m[1] ?? '');
    const bad = labels.filter(l => DIVI_UNMATCHABLE_RE.test(l));
    if (bad.length > 0) {
      notes.push(`Warning: admin label(s) ${bad.map(l => `"${l}"`).join(', ')} contain & < > " or -- and will NOT be matchable by label or match_text afterwards (plugin escaping limitation). Prefer plain labels (letters, digits, spaces) for anything you may need to edit later.`);
    }
  }

  // Phase 47: validation, reference ledger, budgets, surface tiering.
  // Phase 48.1: give the gate a way to inline a module's verified map into an
  // un-consulted-module refusal, so the model fixes the write in one turn.
  const gateCtx = {
    ...ctx,
    lookupModule: (moduleName: string): string | null => {
      const spec = STDIO_SERVERS.diviops?.references;
      if (!spec) {
        return null;
      }
      try {
        return loadReferenceLibrary(spec).module(moduleName);
      } catch {
        return null;
      }
    },
  };
  const gated = diviWriteGate(toolName, out, gateCtx);
  if (gated.refuse) {
    return { args: out, refuse: gated.refuse };
  }
  if (gated.note) {
    notes.push(gated.note);
  }
  return { args: gated.args, note: notes.length > 0 ? notes.join('\n') : undefined };
}

function refuse(message: string): GuardResult {
  return { args: {}, refuse: `[refused] ${message}` };
}

const DIVIOPS_GUIDANCE_HEAD = `<divi_authoring>
DiviOps (Divi 5 authoring) — these rules come from the vendor's divi-5-builder skill and from reading the plugin source; violating them fails SILENTLY (the write succeeds and the page renders wrong or blank). Follow the tagged sections below exactly.

<operating_procedure>
OPERATING PROCEDURE — the ONLY workflow that works. Do these in order, EVERY time, before writing any Divi layout. Skipping a step wastes your turns on refusals:
  1. TEMPLATE FIRST. diviops_template_list → diviops_template_get for the closest match (hero, features, cards, pricing, CTA, etc.). Editing a vendor-verified template is the default path; composing a section from scratch is the EXCEPTION, only when nothing fits.
  2. READ THE MAP. For every module type you will write and have not already read THIS session, call diviops_reference {module:"Heading"} — one call per module. It returns the VB-verified element map + a minimal snippet. The paths you would guess are usually wrong; the gate refuses unknown paths before they reach the site.
  3. BUILD ONLY FROM DOCUMENTED PATHS. When starting from a template, replace only the {{variables}} / text; do not restructure it. When composing, use only paths from the maps you just read.
  4. VALIDATE. diviops_validate_blocks on the markup before any write.
  5. WRITE, THEN VERIFY. Write (section_append / section_replace / page_update_content), then read the [render check] line appended to the result — that is what the site actually shows. Report THAT, never a guess.
Do NOT compose JSON and "try it to see if it passes" — that burns turns and the gate will refuse it. Read first, then write once.
</operating_procedure>

<edit_scope>
EDIT THE SMALLEST UNIT — never rewrite a whole page to change part of it. Rewriting an entire page to fix one heading is how layouts get corrupted and turns get burned.
  - To change ONE module: diviops_module_update by admin label with only the changed attribute paths (a targeted dot-path write), not a page rewrite.
  - To change ONE section: diviops_section_replace with a plain match_text, sending only that section.
  - Only page_update_content / page_create when building a page from scratch or replacing the whole thing on purpose.
  - Read the current state first (diviops_page_get_layout / diviops_section_get), change the minimum, write that minimum. Smaller writes validate faster, cost less, and cannot corrupt the rest of the page.
</edit_scope>

<json_shapes>
FIVE JSON SHAPES THAT SILENTLY BREAK (the gate catches these — get them right the first time):
  a. builderVersion goes INSIDE the attrs object, as a sibling of module/content — e.g. {"attrs":{ …, "builderVersion":"5.1.1"}}. NEVER a trailing key after the closing braces (…}}}, "builderVersion":"…"} is invalid).
  b. Element attribute paths are element-scoped, not module-scoped: a Button's background is button.decoration.button.desktop.value.backgroundColor — NOT module.button… . Read the module map for the exact element name.
  c. Every content-bearing element needs its innerContent wrapper: "content":{"innerContent":{"desktop":{"value":"<p>…</p>"}}} — not a bare string at the top level.
  d. section_append / section_replace take ONE bare section in the "content" arg (NO divi/placeholder wrapper). page_update_content takes the whole page wrapped in one placeholder.
  e. Numeric args are numbers, not strings: page_id: 255, not "255".
</json_shapes>

<rules>
`;
const DIVIOPS_GUIDANCE_TAIL = `- BUILDER POLICY (not negotiable): every WordPress build and every Duda→WordPress migration on this platform is Divi 5. Kadence, Gutenberg-blocks-as-a-builder, Oxygen and Elementor are RETIRED — do not propose, "fall back to", or ask the operator to choose one, even if a build site once used them or a stale note mentions them. If a DiviOps connection's tools are missing this turn, that is NOT a reason to switch builders: it is almost always the connection NAME being too long (see the [system] unavailability note, which tells you to rename it, e.g. "diviops-build-1") — say that and stop; never present another builder as an option.
- NEVER GUESS. The platform GATES every Divi write (page_create, page_update_content, section_append/replace, library_save, tb_layout_update, canvas_*, module_update): the markup is validated against the vendor's module maps — every element, decoration group, breakpoint, innerContent shape, spacing object and media URL — and a write with any unknown attribute path is REFUSED before it reaches the site, with the exact paths named. It is also refused if this conversation has not read the map for every module type in it. So the only workflow that works: (1) diviops_reference {module:"Heading"} — one call per module type you will use, read the element map and the minimal snippet; (2) build the markup ONLY from paths in those maps; (3) diviops_validate_blocks; (4) write; (5) read the [render check] line appended to the write result — that is what the site actually shows. If you are unsure of a path, look it up (module map, {query:"…"}, or diviops_schema_get_module) — never write a plausible path and hope, and never fall back to a Text/Code module with inline HTML because the real module's format is unfamiliar.
- Media: every image/video URL in Divi markup must be on THIS site (upload with wp_upload_media / wp_media_upload first, use the returned site URL). Workspace-library URLs (s.artivio.ai, /api/files/…) and hot-links to other hosts are refused by the gate.
- Drafts have no public URL: fetch_url on an unpublished page returns the 404 page and says so. Verify drafts with diviops_render_preview {page_id} (the gate runs it for you after each write) and give the owner the wp-admin preview link. Never describe a page as rendered or published on the strength of anything but a render check or a browser screenshot.
- Workflow: diviops_page_get_layout / diviops_section_get to read → build block markup → diviops_validate_blocks on the markup → write (section_append / section_replace / page_update_content) → diviops_render_preview to confirm. Never skip validate_blocks before a write; never declare a page fixed without render_preview or a browser check.
- BEFORE composing any section by hand, call diviops_template_list (and diviops_template_get for a match) — hero, features, cards, CTA and other common shapes ship as vendor-verified starter sections. Start from one and edit it; only build module JSON from scratch when nothing there fits.
- THE FAILURE MODE THIS GUIDANCE EXISTS TO PREVENT: never reach for a Code module, or any "insert raw HTML" content mode, as a stand-in for a native module you don't know how to build. Prior page-builder work on this platform — before agents had this guidance — filled pages with walls of raw HTML exactly when the agent didn't know the real module set. Divi 5 has a native module for nearly every ordinary shape (heading, text, button, blurb, icon list, pricing table, testimonial, image, gallery, accordion, tabs, form, counter…) — check diviops_template_list and an existing section on the site before writing a Code module. Legitimate Code-module use is narrow: a genuine third-party embed script, or a snippet the human supplied verbatim — never headings, text, buttons, or anything else with a dedicated module. Before calling a page done, re-check its content for a wp:divi/code block you can't justify that way.
- Every block needs "builderVersion" in its attrs. Leaf modules are self-closing (<!-- wp:divi/text {...} /-->). Section, Row, Column and Group containers need module.decoration.layout.desktop.value.display set. Always use section → row → column → module nesting; wrapperless modules lose styling.
- Write attrs as PLAIN JSON with ordinary HTML strings ("<p>Hello</p>") — the platform re-serialises every block with WordPress's escaping (\\u003c…) before the write, so do NOT hand-escape; hand-escaping is what produced unparseable JSON. A JSON syntax error is reported with the exact spot quoted (⟪HERE⟫) — fix that spot, don't rewrite the whole page. Button content is an OBJECT at button.innerContent.desktop.value {text, linkUrl}. Blurb title is an OBJECT {text}. Heading level lives at title.decoration.font.font.desktop.value.headingLevel. Hover styles are desktop.hover, a sibling of desktop.value. Don't guess icon codes — use diviops_meta_find_icon.
- Give every section meta.adminLabel, using ONLY letters, digits and spaces. The plugin stores & < > " and -- as JSON escapes but looks sections up by raw substring, so such a label (or match_text) can never be matched again. This is why section_replace/section_get report not_found on sections you wrote earlier — it is a plugin limitation, not a wrong page id.
- page_update_content takes the whole page wrapped in <!-- wp:divi/placeholder -->…<!-- /wp:divi/placeholder -->. section_append and section_replace take ONE section with NO placeholder wrapper (the platform strips it from section_replace for you, because a nested placeholder renders the page blank).
- Prefer incremental edits (diviops_module_update by admin label, section_replace with a plain match_text) over rewriting whole pages. Pass backup: true on writes you may need to undo; diviops_rollback_snapshot_restore reverses them. Pass dry_run: true first when unsure.
- WP-CLI is NOT diviops_meta_wp_cli (that needs a local install and is refused here). Use the WordPress Sites tools — wp_cli / wp_cache_flush / wp_upload_media with site="<label>" — for the SAME site; if they are missing, ask the owner to enable WordPress Sites — never ask for WP_PATH or WP_CLI_CMD.
- WHICH SITE: a DiviOps connection is bound to ONE WordPress site. When the workspace has several (connections named diviops-<label>, e.g. mcp__diviops-build-9__…), the label in the tool name IS the site — never write a page through one site's connection because another site's page id looked right. Confirm with diviops_meta_info (site URL) when unsure.
- REFERENCE: call diviops_reference before building a module you have not built THIS session — {module:"Blurb"} returns the vendor's verified element map + a minimal snippet; {query:"…"} searches; no args = index. It is the Tier 2/3 knowledge that turns guessed attribute paths into VB-verified ones. Use it as working knowledge; do not paste its text to the user (licensed reference material).
- MEDIA: DiviOps has no upload tool. Put images on the site with wp_upload_media (WordPress Sites) and reference the returned site URL in the Divi module — never a library URL (private) or a Duda CDN URL (dies at cutover).
</rules>
</divi_authoring>`;

/** Head (operating procedure + JSON gotchas) followed by the detailed rules. */
const DIVIOPS_GUIDANCE = DIVIOPS_GUIDANCE_HEAD + DIVIOPS_GUIDANCE_TAIL;

// Resolve from the APP's node_modules at runtime (not from whatever module
// graph the bundler built) — Next.js never needs to know these packages exist.
const appRequire = createRequire(`${process.cwd()}/package.json`);

export const STDIO_SERVERS: Record<string, StdioServerSpec> = {
  diviops: {
    key: 'diviops',
    name: 'DiviOps (Divi 5 website authoring)',
    perConnection: true,
    credentialLabel:
      'username:application password for the WordPress site (WP Admin → Users → Profile → Application Passwords). Same format as the WordPress plugin.',
    targetLabel: 'The WordPress site URL, e.g. https://clientsite.com',
    resolveEntry: () => {
      try {
        // bin "diviops-mcp" → dist/index.js (verified against @diviops/mcp-server 1.5.38)
        return appRequire.resolve('@diviops/mcp-server/dist/index.js');
      } catch {
        throw new Error(
          '@diviops/mcp-server is not installed. Add it to package.json dependencies and redeploy.',
        );
      }
    },
    buildEnv: (target, credential) => {
      const url = target.trim().replace(/\/$/, '');
      // Credential convention matches the WordPress built-in: "user:app password".
      // App passwords may contain spaces but never a colon, so split at the FIRST colon.
      const idx = credential.indexOf(':');
      if (!url || idx <= 0) {
        throw new Error(
          'DiviOps needs the site URL and a credential in the form username:application-password.',
        );
      }
      return {
        WP_URL: url,
        WP_USER: credential.slice(0, idx).trim(),
        WP_APP_PASSWORD: credential.slice(idx + 1).trim(),
      };
    },
    guidance: DIVIOPS_GUIDANCE,
    guardCall: diviopsGuard,
    afterCall: diviRenderCheck,
    // `diviops_variable_create_fluid_system` (36) is the longest tool name this
    // server exposes → a DiviOps connection name must be ≤ 21 chars (64−7−36).
    maxToolNameLen: 36,
    references: {
      dir: 'vendor/diviops-skill',
      toolName: 'diviops_reference',
      description: 'Look up the DiviOps divi-5-builder reference (vendored Pro skill: verified Divi 5 module attribute paths, innerContent shapes, presets, design tokens, design patterns, mega menu, loops, interactions, tool reference). No arguments = index. {module:"Blurb"} = that module\'s element map + minimal snippet. {file:"module-formats", section:"Gradient background"} = one heading (children included). {query:"button hover padding"} = keyword search. Consult it BEFORE writing block JSON for a module you have not used this session; the paths here are VB-verified and the ones you would guess are usually wrong. Working knowledge only — do not reproduce it verbatim for users.',
      moduleFile: 'divi-5-builder/references/module-formats.md',
      moduleLevel: 4,
    },
  },
};

export function getStdioServer(key: string | null | undefined): StdioServerSpec | undefined {
  return key ? STDIO_SERVERS[key] : undefined;
}

/**
 * A per-connection stdio server may BORROW a WordPress Sites entry instead of
 * holding its own copy of the site's application password (Phase 44). The
 * connection's `url` column then reads `wp-site:<label>`; at spawn time the
 * registry resolves the label to the site's URL + `user:app-password` from
 * the wp_sites vault row. One credential per site, rotated in one place, and
 * an owner never retypes a password to give DiviOps a site it already trusts.
 */
export const WP_SITE_TARGET_PREFIX = 'wp-site:';

export function wpSiteLabelOf(target: string | null | undefined): string | null {
  const t = (target ?? '').trim();
  if (!t.toLowerCase().startsWith(WP_SITE_TARGET_PREFIX)) {
    return null;
  }
  const label = t.slice(WP_SITE_TARGET_PREFIX.length).trim().toLowerCase();
  return label || null;
}

/** For the admin UI: what stdio servers can be added to the catalog. */
export function listStdioServers() {
  return Object.values(STDIO_SERVERS).map(s => ({
    key: s.key,
    name: s.name,
    perConnection: s.perConnection,
    credentialLabel: s.credentialLabel,
    targetLabel: s.targetLabel,
  }));
}
