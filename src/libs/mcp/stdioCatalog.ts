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

import { createRequire } from 'node:module';

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
   * Throw to refuse the call.
   */
  guardCall?: (toolName: string, args: Record<string, unknown>) => {
    args: Record<string, unknown>;
    note?: string;
  };
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

export function diviopsGuard(toolName: string, args: Record<string, unknown>): { args: Record<string, unknown>; note?: string } {
  const out: Record<string, unknown> = { ...args };
  const notes: string[] = [];

  if (DIVI_SECTION_TARGETING_TOOLS.has(toolName)) {
    for (const field of ['label', 'match_text'] as const) {
      const value = out[field];
      if (typeof value === 'string' && DIVI_UNMATCHABLE_RE.test(value)) {
        throw new Error(
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

  return { args: out, note: notes.length > 0 ? notes.join('\n') : undefined };
}

const DIVIOPS_GUIDANCE = `DiviOps (Divi 5 authoring) — these rules come from the vendor's divi-5-builder skill and from reading the plugin source; violating them fails SILENTLY (the write succeeds and the page renders wrong or blank):
- Workflow: diviops_page_get_layout / diviops_section_get to read → build block markup → diviops_validate_blocks on the markup → write (section_append / section_replace / page_update_content) → diviops_render_preview to confirm. Never skip validate_blocks before a write; never declare a page fixed without render_preview or a browser check.
- Every block needs "builderVersion" in its attrs. Leaf modules are self-closing (<!-- wp:divi/text {...} /-->). Section, Row, Column and Group containers need module.decoration.layout.desktop.value.display set. Always use section → row → column → module nesting; wrapperless modules lose styling.
- HTML inside attrs must be unicode-escaped (\\u003cp\\u003e, not <p>). Button content is an OBJECT at button.innerContent.desktop.value {text, linkUrl}. Blurb title is an OBJECT {text}. Heading level lives at title.decoration.font.font.desktop.value.headingLevel. Hover styles are desktop.hover, a sibling of desktop.value. Don't guess icon codes — use diviops_meta_find_icon.
- Give every section meta.adminLabel, using ONLY letters, digits and spaces. The plugin stores & < > " and -- as JSON escapes but looks sections up by raw substring, so such a label (or match_text) can never be matched again. This is why section_replace/section_get report not_found on sections you wrote earlier — it is a plugin limitation, not a wrong page id.
- page_update_content takes the whole page wrapped in <!-- wp:divi/placeholder -->…<!-- /wp:divi/placeholder -->. section_append and section_replace take ONE section with NO placeholder wrapper (the platform strips it from section_replace for you, because a nested placeholder renders the page blank).
- Prefer incremental edits (diviops_module_update by admin label, section_replace with a plain match_text) over rewriting whole pages. Pass backup: true on writes you may need to undo; diviops_rollback_snapshot_restore reverses them. Pass dry_run: true first when unsure.
- diviops_template_list / diviops_template_get return verified starter sections (hero, features, cards, CTA) — start from one rather than from memory.`;

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
  },
};

export function getStdioServer(key: string | null | undefined): StdioServerSpec | undefined {
  return key ? STDIO_SERVERS[key] : undefined;
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
