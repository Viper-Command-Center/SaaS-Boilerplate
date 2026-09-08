/**
 * WordPress Sites — the multi-site built-in provider (Phase 34).
 *
 * Replaces the separate `wordpress` (REST) and `wpcli` (SSH) connectors with
 * ONE connection per workspace that holds N sites. The connection row carries
 * no credential (`noCredential`); the sites, their two secrets and their
 * discovered capabilities live in `wp_sites` (src/libs/wpsites/*).
 *
 * Tool surface (§7). Every tool takes an optional `site` LABEL; with one site
 * or a default site it can be omitted. This is deliberately NOT one tool set
 * per site: Anthropic tool names are capped at 64 chars including the
 * `mcp__wp-sites__` namespace, and three sites × thirty MCP abilities would
 * put ~100 schemas in front of the model on every turn. Labels as arguments
 * keep the surface fixed while the workspace grows.
 *
 * Policy is decided PER CALL (BuiltinProvider.policyFor): which site, which
 * channel (rest/mcp/cli), read or write. Reads run without approval on any
 * channel that is not blocked; writes follow the site's channel setting.
 *
 * Secrets never appear in results: every channel redacts (see
 * wpsites/redact.ts), audit rows carry an argument HASH, and the agent never
 * receives an Authorization header, an application password or a key.
 */

import type { ToolPolicy } from '@/libs/mcp/registry';
import type { BuiltinProvider, BuiltinTool } from '@/libs/plugins/types';
import type { Channel, ResolvedSite } from '@/libs/wpsites/types';
import { assertArgsSafe, shellQuote } from '@/libs/plugins/wpcli';
import { getFile } from '@/libs/storage/files';
import { getObject } from '@/libs/storage/r2';
import { logSiteCall } from '@/libs/wpsites/audit';
import { cliExec, cliRaw, cliUpload, explainRestFailure, mcpCall, mcpListTools, renderCli, requireSsh, restRequest } from '@/libs/wpsites/channels';
import { formatReport, runSiteTest } from '@/libs/wpsites/discovery';
import { pickPluginZip } from '@/libs/wpsites/pluginZip';
import { cliIsWrite, restIsWrite, serialisedForSite, toToolPolicy } from '@/libs/wpsites/policy';
import { MAX_SITE_FILE_BYTES, resolveSitePath } from '@/libs/wpsites/sitePath';
import { listSites, resolveSiteByLabel } from '@/libs/wpsites/store';

const MAX_BODY = 200_000;

/**
 * F5 (Noah's capability test, 2026-09-06): the model sometimes sends `args`
 * as one string ("cron event list --format=json") or with numbers in the
 * array (["post","get",27]). Both are unambiguous; refusing them read as an
 * intermittent platform bug. Strings split on whitespace (no quoting — a
 * value with spaces must be an array element); scalars are stringified.
 */
export function normaliseArgv(raw: unknown): string[] {
  if (typeof raw === 'string') {
    const t = raw.trim();
    // A JSON array sent as a string ('["plugin","get","x"]') — seen live
    // 2026-09-07: whitespace-splitting it yields '["plugin",' which WP-CLI
    // reports as "not a registered wp command".
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) {
          return normaliseArgv(parsed);
        }
      } catch { /* not strict JSON — try the lenient bracket form below */ }
      // ['plugin', 'get', '--field=version'] — single quotes, or a trailing
      // comma: still unambiguous. Strip the brackets, split on commas, unquote.
      const inner = t.replace(/^\[|\]$/g, '');
      const parts = inner.split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      if (parts.length) {
        return parts;
      }
    }
    return t.replace(/^wp\s+/, '').split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw
      .filter(a => a !== null && a !== undefined)
      .map(a => (typeof a === 'string' ? a : typeof a === 'number' || typeof a === 'boolean' ? String(a) : JSON.stringify(a)));
  }
  return [];
}

/** CLI commands after which web requests must see fresh state (F2 root cause). */
const CLI_FLUSH_AFTER_RE = /^(?:plugin|theme|core|option|rewrite|language|site)\s+(?:install|activate|deactivate|toggle|update|delete|uninstall|add|patch|set|flush|switch)/;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_PLUGIN_ZIP_BYTES = 80 * 1024 * 1024;
/** Media uploads over REST get three times the ordinary budget: a multipart POST through shared-hosting PHP is slow. */
const UPLOAD_TIMEOUT_MS = 90_000;

const SITE_ARG = {
  site: { type: 'string', description: 'Site label (from wp_sites). Optional when the workspace has one site or a default site.' },
} as const;

/** MCP abilities whose NAME says they only read. Everything else is a write. */
const MCP_READ_RE = /(?:^|[/._:-])(?:get|list|read|find|search|describe|query|export|inspect|show|status|info)(?:$|[/._:-])/i;

// ─── Tools ───────────────────────────────────────────────────────────────────

const tools: BuiltinTool[] = [
  {
    name: 'wp_sites',
    description: 'List the WordPress sites in this workspace: label, URL, which is default, health status, detected page builder, which channels work (rest / mcp / cli) and each channel\'s policy. Call this when a task names a site you have not seen, or when more than one site exists and the task did not say which.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'wp_site_status',
    description: 'Run the connection diagnostic on one site (the same report as the Test button): reachability, REST auth, role, MCP endpoint + tools, builder, SSH + WP-CLI path, cache. Refreshes the discovered facts. Use it when a channel fails unexpectedly — the report says which of credential / plugin / key / path is wrong, with the fix.',
    input_schema: {
      type: 'object',
      properties: { ...SITE_ARG, write_probe: { type: 'boolean', description: 'Also create and delete a draft "_artivio_probe" to prove writes work. Default false.' } },
    },
  },
  {
    name: 'wp_rest',
    description: 'Call the site\'s REST API. route is relative to /wp-json — e.g. "/wp/v2/pages?per_page=20&search=about", "/wp/v2/posts/12", "/artivio/v1/site", "/wp/v2/media". GET is a read; POST/PUT/PATCH/DELETE are writes and follow the site\'s REST policy. body is JSON. Prefer the typed wp_content_* tools for posts and pages; use this for taxonomies, menus, users, plugin routes, and anything they do not cover.',
    input_schema: {
      type: 'object',
      properties: {
        ...SITE_ARG,
        method: { type: 'string', description: 'GET | POST | PUT | PATCH | DELETE (default GET)' },
        route: { type: 'string', description: 'Path under /wp-json, may include a query string.' },
        body: { type: 'object', description: 'JSON body for writes.' },
      },
      required: ['route'],
    },
  },
  {
    name: 'wp_cli',
    description: 'Run one WP-CLI command on the site over SSH. Pass argv WITHOUT the leading "wp" — e.g. ["option","get","blogname"], ["plugin","list","--status=active","--format=json"], ["post","list","--post_type=page","--fields=ID,post_title","--format=json"], ["rewrite","flush"]. Prefer --format=json. The site path is pinned (never pass --path/--url). Refused by the platform: eval, eval-file, shell, db drop/reset/clean/import/query, site empty/delete, core download/install, and a live search-replace (use wp_search_replace). Reads run freely; writes follow the site\'s CLI policy.',
    input_schema: {
      type: 'object',
      properties: { ...SITE_ARG, args: { type: 'array', items: { type: 'string' }, description: 'argv after "wp", one element per token.' } },
      required: ['args'],
    },
  },
  {
    name: 'wp_mcp_tools',
    description: 'List the abilities the site exposes over its MCP endpoint (Oxygen Agent Connector, WordPress MCP Adapter…) with descriptions and input schemas. Builder abilities (oxygen/*, bricks/*…) are how layouts are edited on those builders. Call this before wp_mcp on a site you have not used this conversation.',
    input_schema: { type: 'object', properties: { ...SITE_ARG, filter: { type: 'string', description: 'Substring to filter names, e.g. "oxygen".' } } },
  },
  {
    name: 'wp_mcp',
    description: 'Call one MCP ability on the site by name with its arguments (from wp_mcp_tools). Abilities that read (get/list/search/describe…) run freely; others follow the site\'s MCP policy. Builder tree edits are NOT transactional — call wp_snapshot before a bulk or destructive change.',
    input_schema: {
      type: 'object',
      properties: { ...SITE_ARG, tool: { type: 'string' }, args: { type: 'object', description: 'Arguments per the ability\'s input schema.' } },
      required: ['tool'],
    },
  },
  {
    name: 'wp_snapshot',
    description: 'Take a database snapshot of the site over WP-CLI (wp db export) into a folder OUTSIDE the web root, keeping the last 5. Call it before bulk or destructive operations (search-replace, plugin updates, builder-wide edits). Returns the file path so a human can restore with `wp db import` if needed. Needs the CLI channel.',
    input_schema: { type: 'object', properties: { ...SITE_ARG, note: { type: 'string', description: 'Short reason, kept in the filename.' } } },
  },
  {
    name: 'wp_content_list',
    description: 'List posts or pages (newest first) with id, status, slug, link, title and a short excerpt. Posts and pages are SEPARATE collections in WordPress — say which.',
    input_schema: {
      type: 'object',
      properties: {
        ...SITE_ARG,
        type: { type: 'string', description: 'post | page (default post)' },
        search: { type: 'string' },
        status: { type: 'string', description: 'publish | draft | any (default publish)' },
        per_page: { type: 'number', description: 'Max 50' },
      },
    },
  },
  {
    name: 'wp_content_get',
    description: 'Fetch one post or page with its full HTML content (raw, as stored) so you can rewrite or extend it. On a page-builder site the builder connection\'s tools show the real layout; post_content may be empty or stale there.',
    input_schema: { type: 'object', properties: { ...SITE_ARG, id: { type: 'number' }, type: { type: 'string', description: 'post | page (default post)' } }, required: ['id'] },
  },
  {
    name: 'wp_content_create',
    description: 'Create a blog POST or a PAGE. Defaults to DRAFT — set status="publish" only when a human approved publishing in this conversation. Content is HTML rendered through the theme; on a page-builder site a designed layout needs the builder\'s own tools instead. The result states which type was created.',
    input_schema: {
      type: 'object',
      properties: {
        ...SITE_ARG,
        type: { type: 'string', description: 'post | page — REQUIRED so the wrong kind is never made by default.' },
        title: { type: 'string' },
        content: { type: 'string', description: 'HTML body' },
        excerpt: { type: 'string' },
        status: { type: 'string', description: 'draft (default) | publish' },
        slug: { type: 'string' },
        parent: { type: 'number', description: 'Parent page id (pages only).' },
        categories: { type: 'array', items: { type: 'number' }, description: 'Category ids (posts only).' },
        tags: { type: 'array', items: { type: 'number' } },
        featuredMediaId: { type: 'number', description: 'WordPress media id from wp_upload_media.' },
      },
      required: ['type', 'title', 'content'],
    },
  },
  {
    name: 'wp_content_update',
    description: 'Update a post or page (title, content, excerpt, status, slug, featured image). Read it first with wp_content_get so you keep what should stay. status="trash" is NOT valid here — use wp_content_trash.',
    input_schema: {
      type: 'object',
      properties: {
        ...SITE_ARG,
        id: { type: 'number' },
        type: { type: 'string', description: 'post | page (default post) — must match where the id came from.' },
        title: { type: 'string' },
        content: { type: 'string' },
        excerpt: { type: 'string' },
        status: { type: 'string' },
        slug: { type: 'string' },
        featuredMediaId: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'wp_content_trash',
    description: 'Move a post or page to the Trash. Reversible; nothing here can permanently delete.',
    input_schema: { type: 'object', properties: { ...SITE_ARG, id: { type: 'number' }, type: { type: 'string', description: 'post | page (default post)' } }, required: ['id'] },
  },
  {
    name: 'wp_upload_media',
    description: 'Upload an image/PDF/video from the workspace file library into the site\'s Media Library. Pass the LIBRARY FILE ID (from list_files, extract_document_images, save_file_from_url) — never a URL or bytes. Returns the WordPress media id (featuredMediaId) and the site-hosted source_url — use THAT url in layouts and headers, never a library URL (library URLs are private to the workspace). On sites with SSH the bytes go over SFTP + wp media import (reliable on shared hosts); otherwise REST.',
    input_schema: {
      type: 'object',
      properties: { ...SITE_ARG, fileId: { type: 'string' }, title: { type: 'string' }, altText: { type: 'string' }, caption: { type: 'string' } },
      required: ['fileId'],
    },
  },
  {
    name: 'wp_read_file',
    description: 'Read a text file from the site (relative to the site root, under wp-content/ only) — a plugin\'s main file, an mu-plugin, a theme\'s functions.php — before editing it. Needs the CLI channel. Capped at 512 KB.',
    input_schema: { type: 'object', properties: { ...SITE_ARG, path: { type: 'string', description: 'e.g. "wp-content/mu-plugins/site-fixes.php"' } }, required: ['path'] },
  },
  {
    name: 'wp_write_file',
    description: 'Write a text file on the site, under wp-content/{mu-plugins,plugins,themes,languages}/ only. This is how site-level PHP is added: an mu-plugin (wp-content/mu-plugins/<name>.php — auto-loads, survives updates; PREFER this), a plugin body after wp scaffold, or a theme file. Safety rails the platform applies: a .php file is syntax-checked (php -l) on the host BEFORE it goes live; after writing, WordPress is bootstrapped once and if it fatals the new file is renamed to .disabled and the previous version restored — a broken mu-plugin would otherwise white-screen the whole site. Existing files are backed up (<name>.bak-<stamp>) and need overwrite:true. wp eval / eval-file stay refused — write a file instead. Needs the CLI channel; follows the site\'s CLI policy.',
    input_schema: {
      type: 'object',
      properties: {
        ...SITE_ARG,
        path: { type: 'string', description: 'Relative to the site root, e.g. "wp-content/mu-plugins/bbi-shortcodes.php".' },
        content: { type: 'string', description: 'The full file content (≤ 512 KB). For PHP start with "<?php" and a plugin header comment.' },
        overwrite: { type: 'boolean', description: 'Required to replace a file that already exists (a backup is kept).' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'wp_install_plugin',
    description: 'Install a plugin from a .zip in the workspace file library (premium plugins: Slider Revolution, ACF Pro, WP Rocket…). Pass the LIBRARY FILE ID. The platform pushes the zip to the host over SFTP, unwraps a package zip that contains the real plugin zip, runs `wp plugin install --force`, optionally activates, flushes caches and removes the temp file. This is the ONLY working route: library URLs are private (the host cannot download them) and the Media Library rejects .zip. Needs the CLI channel. For wordpress.org plugins use wp_cli ["plugin","install","<slug>","--activate"].',
    input_schema: {
      type: 'object',
      properties: { ...SITE_ARG, fileId: { type: 'string' }, activate: { type: 'boolean', description: 'Activate after install (default true).' } },
      required: ['fileId'],
    },
  },
  {
    name: 'wp_oxygen_replace',
    description: 'Oxygen only. Rewrite part of a page in ONE call: delete the listed existing element ids (oxygen-edit-post delete ops), then insert new HTML (oxygen-html-to-page) at the given parent/position. oxygen-html-to-page itself only APPENDS, so a "fix this section" done as two separate calls has left pages with 3–4 copies of every section. Read the tree first (oxygen-get-post-tree) to get the ids; call wp_snapshot before a large rewrite. Returns both step results and the page it wrote to.',
    input_schema: {
      type: 'object',
      properties: {
        ...SITE_ARG,
        post_id: { type: 'number', description: 'The page/template id (verify its title first).' },
        delete_element_ids: { type: 'array', items: { type: 'number' }, description: 'Top-level element ids to remove first (children go with them). Empty = insert only.' },
        html: { type: 'string', description: 'The replacement HTML (same rules as oxygen-html-to-page).' },
        parent_id: { type: 'number', description: 'Insert under this element (omit = page root).' },
        position: { type: 'number', description: 'Index among the parent\'s children (omit = end).' },
      },
      required: ['post_id', 'html'],
    },
  },
  {
    name: 'wp_seo_get',
    description: 'Read a page/post\'s SEO fields (title, description, focus keyword, canonical, robots, social cards) from Rank Math or Yoast, with character counts. Needs the artivio-wp-agent base plugin on the site.',
    input_schema: { type: 'object', properties: { ...SITE_ARG, id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'wp_seo_update',
    description: 'Set SEO fields on a page/post; omitted fields are untouched, "" clears one. Field names are the same on every site (mapped onto Rank Math / Yoast) — never write raw meta keys. Needs the artivio-wp-agent base plugin.',
    input_schema: {
      type: 'object',
      properties: {
        ...SITE_ARG,
        id: { type: 'number' },
        title: { type: 'string' },
        description: { type: 'string' },
        focusKeyword: { type: 'string' },
        canonical: { type: 'string' },
        breadcrumbTitle: { type: 'string' },
        noindex: { type: 'boolean' },
        nofollow: { type: 'boolean' },
        ogTitle: { type: 'string' },
        ogDescription: { type: 'string' },
        ogImage: { type: 'string' },
        twitterTitle: { type: 'string' },
        twitterDescription: { type: 'string' },
        twitterImage: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'wp_cache_flush',
    description: 'Over WP-CLI: flush the object cache, delete all transients, flush rewrite rules, and purge LiteSpeed Cache when present. Use after changes that do not show on the live site.',
    input_schema: { type: 'object', properties: { ...SITE_ARG } },
  },
  {
    name: 'wp_search_replace',
    description: 'Database search/replace over WP-CLI (serialised-data safe) — for a domain change, http→https, or a renamed asset path. dry_run defaults to TRUE and reports per-table counts; only pass dry_run:false after the human has seen them. GUID column is skipped. Take wp_snapshot first.',
    input_schema: {
      type: 'object',
      properties: {
        ...SITE_ARG,
        search: { type: 'string' },
        replace: { type: 'string' },
        dry_run: { type: 'boolean', description: 'Default true.' },
        tables: { type: 'array', items: { type: 'string' } },
        all_tables: { type: 'boolean' },
      },
      required: ['search', 'replace'],
    },
  },
];

/**
 * `args` for wp_mcp arrives as a JSON STRING often enough to matter
 * (`"args": "{\"post_id\": 43}"`, 2026-09-07) — the site's Abilities API then
 * says "post_id is a required property", which the agent reported as an
 * intermittent platform bug. Same class as normaliseArgv: unambiguous, accept.
 */
export function mcpArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw new Error('wp_mcp: args must be a JSON object (it arrived as a string that is not valid JSON). Pass it as an object, not a string.');
    }
  }
  return {};
}

// ─── Channel + write classification (drives policy AND the write queue) ──────

function classify(tool: string, args: Record<string, unknown>): { channel: Channel | 'meta'; write: boolean } {
  switch (tool) {
    case 'wp_sites':
    case 'wp_site_status':
      return { channel: 'meta', write: false };
    case 'wp_rest':
      return { channel: 'rest', write: restIsWrite(String(args.method ?? 'GET')) };
    case 'wp_cli':
      return { channel: 'cli', write: cliIsWrite(normaliseArgv(args.args)) };
    case 'wp_mcp_tools':
      return { channel: 'mcp', write: false };
    case 'wp_mcp':
      return { channel: 'mcp', write: !MCP_READ_RE.test(String(args.tool ?? '')) };
    case 'wp_oxygen_replace':
      return { channel: 'mcp', write: true };
    case 'wp_snapshot':
    case 'wp_cache_flush':
      // Protective / housekeeping: they change nothing a visitor sees. Reads
      // for policy purposes, still serialised with writes below.
      return { channel: 'cli', write: false };
    case 'wp_search_replace':
      return { channel: 'cli', write: args.dry_run === false };
    case 'wp_install_plugin':
    case 'wp_write_file':
      return { channel: 'cli', write: true };
    case 'wp_read_file':
      return { channel: 'cli', write: false };
    case 'wp_content_list':
    case 'wp_content_get':
    case 'wp_seo_get':
      return { channel: 'rest', write: false };
    default:
      return { channel: 'rest', write: true };
  }
}

function slim(items: unknown): unknown {
  if (!Array.isArray(items)) {
    return items;
  }
  return items.map((p: Record<string, any>) => ({
    id: p.id,
    status: p.status,
    slug: p.slug,
    link: p.link,
    title: p.title?.rendered ?? p.title,
    date: p.date,
    excerpt: typeof p.excerpt?.rendered === 'string' ? p.excerpt.rendered.replace(/<[^>]+>/g, '').slice(0, 160) : undefined,
  }));
}

async function rest(site: ResolvedSite, method: string, route: string, body?: unknown, init?: { headers?: Record<string, string>; raw?: BodyInit; timeoutMs?: number }) {
  const r = await restRequest(site, method, route, body, init);
  if (!r.ok) {
    throw new Error(explainRestFailure(site, r, route));
  }
  return r.body;
}

/** Identify the page/post a builder write targets (post_id / id / postId). */
async function describeTarget(site: ResolvedSite, a: Record<string, unknown>): Promise<{ id: number; exists: boolean; verified: boolean; title: string; type: string; status: string; link: string } | null> {
  const raw = a.post_id ?? a.postId ?? a.id;
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }
  for (const coll of ['pages', 'posts'] as const) {
    const r = await restRequest(site, 'GET', `/wp/v2/${coll}/${id}?context=edit&_fields=id,title,status,link,type`).catch(() => null);
    if (r?.ok && r.body && typeof r.body === 'object') {
      const b = r.body as Record<string, any>;
      return { id, exists: true, verified: true, title: String(b.title?.raw ?? b.title?.rendered ?? '').slice(0, 80), type: String(b.type ?? coll), status: String(b.status ?? ''), link: String(b.link ?? '') };
    }
    if (r && r.status !== 404) {
      // Auth/network trouble: don't block the write on a side lookup.
      return null;
    }
  }
  // 🔴 Phase 36 refused here on 404-for-both, which blocked every write to an
  // Oxygen header/footer/template (CPTs with no REST route) — Noah's v2 Bug 3
  // was OUR guardrail, not Oxygen. The only trustworthy "does post N exist"
  // for ANY post type is WP-CLI; without CLI the answer is "unverified", and
  // an unverified target is annotated, never refused.
  if (site.ssh && site.policy.cli !== 'blocked') {
    const r = await cliExec(site, ['post', 'get', String(id), '--fields=ID,post_title,post_type,post_status', '--format=json']).catch(() => null);
    if (r && r.code === 0) {
      try {
        const b = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
        return { id, exists: true, verified: true, title: String(b.post_title ?? '').slice(0, 80), type: String(b.post_type ?? ''), status: String(b.post_status ?? ''), link: '' };
      } catch { /* fall through to unverified */ }
    } else if (r && /Could not find the post/i.test(`${r.stderr}${r.stdout}`)) {
      return { id, exists: false, verified: true, title: '', type: '', status: '', link: '' };
    }
  }
  return { id, exists: true, verified: false, title: '', type: '', status: '', link: '' };
}

function collection(args: Record<string, unknown>): 'posts' | 'pages' {
  return String(args.type ?? 'post').toLowerCase() === 'page' ? 'pages' : 'posts';
}

// ─── Execution ───────────────────────────────────────────────────────────────

async function execute(tool: string, args: Record<string, unknown>, tenantId: string, site: ResolvedSite | null): Promise<string> {
  if (tool === 'wp_sites') {
    const sites = await listSites(tenantId);
    if (sites.length === 0) {
      return 'No WordPress sites are configured in this workspace yet. The owner adds them in Tools → WordPress Sites (label + URL + application password; SSH optional).';
    }
    return JSON.stringify(sites.map(s => ({
      label: s.label,
      url: s.siteUrl,
      default: s.isDefault,
      status: s.status,
      builder: s.builder,
      wp: s.wpVersion,
      channels: { rest: s.capabilities.rest, mcp: s.capabilities.mcp, cli: s.capabilities.cli },
      policy: s.policy,
      mcp_tools: s.capabilities.mcp_tools.length,
      base_plugin: s.capabilities.base_plugin,
      last_test: s.lastTestAt,
    })), null, 1);
  }
  if (!site) {
    throw new Error('WordPress Sites: no site resolved.');
  }

  switch (tool) {
    case 'wp_site_status': {
      const report = await runSiteTest(tenantId, site.id, { writeProbe: args.write_probe === true });
      return formatReport(site.label, report);
    }
    case 'wp_rest': {
      const method = String(args.method ?? 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
        throw new Error(`WordPress Sites: method ${method} is not allowed.`);
      }
      const r = await restRequest(site, method, String(args.route ?? ''), args.body);
      if (!r.ok) {
        throw new Error(explainRestFailure(site, r, String(args.route ?? '')));
      }
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n…[truncated at ${MAX_BODY} chars — narrow the query with per_page/_fields]` : text;
    }
    case 'wp_cli': {
      const argv = normaliseArgv(args.args);
      if (argv.length === 0) {
        throw new Error('WordPress Sites: args must be a non-empty array of strings, e.g. ["plugin","list","--format=json"].');
      }
      const out = renderCli(await cliExec(site, argv), `wp ${argv.slice(0, 2).join(' ')}`);
      // F2 root cause: a plugin activated over WP-CLI was invisible to web
      // requests because `active_plugins` (alloptions) sat in the persistent
      // object cache (LiteSpeed). REST then reported "no SEO plugin" while
      // `wp plugin list` said active. Flush the object cache after any command
      // that changes what loads, so the next REST call sees it.
      const words = argv.filter(a => !a.startsWith('-')).slice(0, 2).join(' ');
      if (CLI_FLUSH_AFTER_RE.test(words)) {
        const flushed = await cliExec(site, ['cache', 'flush']).then(r => r.code === 0).catch(() => false);
        return `${out}\n\n[artivio] object cache ${flushed ? 'flushed' : 'flush FAILED'} so web requests (REST, MCP, visitors) see this change immediately.`;
      }
      return out;
    }
    case 'wp_mcp_tools': {
      const list = await mcpListTools(site);
      const filter = String(args.filter ?? '').toLowerCase();
      const shown = filter ? list.filter(t => t.name.toLowerCase().includes(filter)) : list;
      return JSON.stringify({
        site: site.label,
        endpoint: site.mcpEndpointUrl,
        count: shown.length,
        tools: shown.map(t => ({
          name: t.name,
          description: (t.description ?? '').slice(0, 300),
          readOnly: t.annotations?.readOnlyHint ?? undefined,
          input_schema: t.inputSchema,
        })),
      }).slice(0, MAX_BODY);
    }
    case 'wp_mcp': {
      const name = String(args.tool ?? '').trim();
      if (!name) {
        throw new Error('WordPress Sites: tool is required — pick one from wp_mcp_tools.');
      }
      const a = mcpArgs(args.args);
      const isWrite = !MCP_READ_RE.test(name);
      const target = isWrite ? await describeTarget(site, a) : null;
      if (target && !target.exists) {
        throw new Error(`wp_mcp ${name}: post ${target.id} does not exist on ${site.label} (WP-CLI: "Could not find the post"). Page ids in notes go stale when pages are recreated — call wp_content_list type:page (or oxygen-search-posts for templates) and use the id whose TITLE is the one you mean.`);
      }
      const out = await mcpCall(site, name, a);
      // build.churchwebglobal.com, 2026-09-07: the Sermons layout was written
      // to the Events page and the Events layout to Contact, because the ids
      // in the agent's notes were from a previous build. The write "succeeded".
      // Name the page every write actually touched so the agent can see it.
      return target
        ? target.verified
          ? `${out}\n\n[artivio] wrote to #${target.id} "${target.title}" (${target.type}, ${target.status})${target.link ? ` ${target.link}` : ''}`
          : `${out}\n\n[artivio] wrote to #${target.id} — not a page or post (a builder template or other custom post type); title not verifiable without the CLI channel. Confirm with oxygen-search-posts if unsure.`
        : out;
    }
    case 'wp_snapshot': {
      const ssh = requireSsh(site);
      const parent = ssh.path.replace(/\/[^/]+$/, '') || '/';
      const dir = `${parent}/artivio-snapshots`;
      const note = String(args.note ?? '').replace(/[^\w-]+/g, '-').slice(0, 30);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = `${dir}/${site.label}-${stamp}${note ? `-${note}` : ''}.sql`;
      const cmd = [
        `mkdir -p ${shellQuote(dir)}`,
        `chmod 700 ${shellQuote(dir)}`,
        // --skip-plugins/--skip-themes: a dump needs no plugin code, and a
        // plugin that fatals under CLI (exit 255, no message) must not block a
        // backup. --no-tablespaces: MySQL 8 hosts (Hostinger) deny PROCESS to
        // site users and mysqldump fails without it. (F1, 2026-09-06)
        ['wp', `--path=${ssh.path}`, '--no-color', '--skip-plugins', '--skip-themes', 'db', 'export', file, '--add-drop-table', '--no-tablespaces'].map(shellQuote).join(' '),
        // Keep the newest 5 for this label.
        `ls -1t ${shellQuote(dir)}/${shellQuote(site.label)}-*.sql 2>/dev/null | tail -n +6 | xargs -r rm -f`,
        `ls -la ${shellQuote(file)}`,
      ].join(' && ');
      let out: string;
      try {
        out = renderCli(await cliRaw(site, cmd), 'wp db export');
      } catch (err) {
        // Exit 255 with NO output (Hostinger, 2026-09-06/07) is either a
        // missing mysqldump or a PHP fatal that CLI display_errors=Off hides.
        // Find out here, once, instead of handing the agent a bare exit code
        // to speculate about — it already guessed twice.
        const msg = err instanceof Error ? err.message : String(err);
        const diag = await cliRaw(site, [
          'echo "mysqldump: $(command -v mysqldump || echo MISSING)"',
          'echo "wp: $(command -v wp || echo MISSING)"',
          'echo "php: $(php -r \'echo PHP_VERSION;\' 2>&1)"',
          'echo "disabled: $(php -r \'echo ini_get("disable_functions");\' 2>&1)"',
          `echo "dir: $(ls -ld ${shellQuote(dir)} 2>&1)"`,
          // Force fatals to stderr; dump ONE small table to stdout, capped.
          `php -d display_errors=stderr -d error_reporting=E_ALL "$(command -v wp)" --path=${shellQuote(ssh.path)} --no-color --skip-plugins --skip-themes db export - --no-tablespaces --tables=wp_options 2>&1 | head -c 1500`,
        ].join('; ')).catch(e => ({ stdout: '', stderr: e instanceof Error ? e.message : 'diagnostic failed', code: 1 }));
        const report = `${diag.stdout}\n${diag.stderr}`.trim();
        const noDump = /mysqldump: MISSING/.test(report);
        // Hostinger (2026-09-07, Noah): mysqldump exists but PHP exec() is in
        // disable_functions, so WP-CLI's db export dies with an uncaught
        // "Call to undefined function exec()". Nothing on our side fixes it.
        const noExec = /undefined function exec\(\)|disabled:[^\n]*\bexec\b/.test(report);
        if (noExec && !noDump) {
          throw new Error(
            `Snapshots are not available on this host: PHP exec() is disabled in php.ini, and WP-CLI's db export needs it to run mysqldump. This is a hosting restriction, not an Artivio or WordPress fault. Tell the human to take a backup from the hosting control panel (Hostinger: hPanel → Websites → Backups) before destructive changes, and proceed only if they accept working without a snapshot.\n\n[snapshot diagnostics]\n${report}`,
          );
        }
        throw new Error(
          `${msg}\n\n[snapshot diagnostics]\n${report}\n\n${
            noDump
              ? 'ROOT CAUSE: mysqldump is not installed for this SSH user, so WP-CLI cannot export. Nothing on the Artivio side can fix that. Tell the human: on Hostinger take backups from hPanel → Websites → Backups (or ask their support to enable mysqldump); on other hosts install mysql-client. Proceed with the build only if the human accepts working without a snapshot.'
              : 'Read the diagnostics above: a "PHP Fatal" line names the real cause; a mysqldump "Got error"/"Access denied" line is a database-credential or privilege problem. Report the exact line to the human; do not skip the snapshot silently.'}`,
        );
      }
      return `Snapshot written: ${file}\n${out}\nRestore (human, over SSH): wp --path=${ssh.path} db import ${file}`;
    }
    case 'wp_content_list': {
      const params = new URLSearchParams({
        per_page: String(Math.min(Number(args.per_page) || 10, 50)),
        ...(collection(args) === 'posts' ? { status: String(args.status || 'publish') } : { status: String(args.status || 'publish') }),
        ...(args.search ? { search: String(args.search) } : {}),
      });
      return JSON.stringify(slim(await rest(site, 'GET', `/wp/v2/${collection(args)}?${params}`)));
    }
    case 'wp_content_get': {
      const p = await rest(site, 'GET', `/wp/v2/${collection(args)}/${Number(args.id)}?context=edit`) as Record<string, any>;
      return JSON.stringify({
        id: p.id,
        type: collection(args) === 'pages' ? 'page' : 'post',
        title: p.title?.raw ?? p.title?.rendered,
        status: p.status,
        slug: p.slug,
        link: p.link,
        content: String(p.content?.raw ?? p.content?.rendered ?? '').slice(0, MAX_BODY),
      });
    }
    case 'wp_content_create': {
      const type = String(args.type ?? '').toLowerCase();
      if (type !== 'post' && type !== 'page') {
        throw new Error('WordPress Sites: type must be "post" or "page" — this is deliberate, so the wrong kind is never created by default.');
      }
      const isPage = type === 'page';
      const created = await rest(site, 'POST', isPage ? '/wp/v2/pages' : '/wp/v2/posts', {
        title: String(args.title ?? ''),
        content: String(args.content ?? ''),
        excerpt: args.excerpt ? String(args.excerpt) : undefined,
        status: String(args.status || 'draft'),
        ...(args.slug ? { slug: String(args.slug) } : {}),
        ...(isPage && args.parent ? { parent: Number(args.parent) } : {}),
        ...(!isPage ? { categories: args.categories, tags: args.tags } : {}),
        ...(args.featuredMediaId ? { featured_media: Number(args.featuredMediaId) } : {}),
      }) as Record<string, any>;
      return JSON.stringify({
        id: created.id,
        type,
        status: created.status,
        slug: created.slug,
        link: created.link,
        note: created.status === 'draft' ? `Saved as a DRAFT ${type} on ${site.label} — nothing is live until published.` : `Published live as a ${type} on ${site.label}.`,
      });
    }
    case 'wp_content_update': {
      if (String(args.status ?? '') === 'trash') {
        throw new Error('WordPress has no "trash" status — use wp_content_trash.');
      }
      const updated = await rest(site, 'POST', `/wp/v2/${collection(args)}/${Number(args.id)}`, {
        ...(args.title !== undefined ? { title: String(args.title) } : {}),
        ...(args.content !== undefined ? { content: String(args.content) } : {}),
        ...(args.excerpt !== undefined ? { excerpt: String(args.excerpt) } : {}),
        ...(args.status !== undefined ? { status: String(args.status) } : {}),
        ...(args.slug !== undefined ? { slug: String(args.slug) } : {}),
        ...(args.featuredMediaId ? { featured_media: Number(args.featuredMediaId) } : {}),
      }) as Record<string, any>;
      return JSON.stringify({ id: updated.id, status: updated.status, link: updated.link, updated: true });
    }
    case 'wp_content_trash': {
      const trashed = await rest(site, 'DELETE', `/wp/v2/${collection(args)}/${Number(args.id)}`) as Record<string, any>;
      return JSON.stringify({ id: Number(args.id), trashed: true, status: trashed?.status ?? 'trash', note: 'Moved to Trash — recoverable in WP Admin.' });
    }
    case 'wp_upload_media': {
      const fileId = String(args.fileId ?? '').trim();
      const row = await getFile(tenantId, fileId);
      if (!row) {
        throw new Error(`No file with id "${fileId}" in this workspace's library — pass the id from list_files / extract_document_images, not a URL.`);
      }
      if (row.sizeBytes > MAX_UPLOAD_BYTES) {
        throw new Error(`${row.name} is ${Math.round(row.sizeBytes / 1024 / 1024)}MB; uploads are capped at ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.`);
      }
      const { body: bytes, contentType } = await getObject(row.r2Key);
      const mime = row.mime && row.mime !== 'application/octet-stream' ? row.mime : contentType;
      const filename = row.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'upload';
      const meta = {
        ...(args.title ? { title: String(args.title) } : {}),
        ...(args.altText ? { alt_text: String(args.altText) } : {}),
        ...(args.caption ? { caption: String(args.caption) } : {}),
      };
      const errors: string[] = [];

      // Route 1 — SFTP + `wp media import` when the CLI channel is usable.
      // Noah's v2 Bug 1 (2026-09-07): every REST upload to Hostinger timed out
      // ("could not reach … aborted due to timeout") while WP-CLI on the same
      // host imported a public URL fine. A multipart POST through the host's
      // PHP/WAF stack is the fragile part; bytes over SFTP + a local import is
      // the same route wp_install_plugin uses and skips all of it.
      if (site.ssh && site.policy.cli !== 'blocked') {
        const ssh = site.ssh;
        const parent = ssh.path.replace(/\/[^/]+$/, '') || '/';
        const dir = `${parent}/artivio-uploads`;
        const remote = `${dir}/${Date.now()}-${filename.slice(0, 80)}`;
        try {
          renderCli(await cliRaw(site, `mkdir -p ${shellQuote(dir)} && chmod 700 ${shellQuote(dir)}`), 'mkdir');
          await cliUpload(site, remote, Buffer.from(bytes));
          try {
            const importArgs = ['media', 'import', remote, '--porcelain', ...(args.title ? [`--title=${String(args.title)}`] : []), ...(args.altText ? [`--alt=${String(args.altText)}`] : []), ...(args.caption ? [`--caption=${String(args.caption)}`] : [])];
            const out = renderCli(await cliExec(site, importArgs), 'wp media import');
            const mediaId = Number(out.trim().split(/\s+/).pop());
            if (!Number.isFinite(mediaId) || mediaId <= 0) {
              throw new Error(`wp media import returned no attachment id: ${out.slice(0, 300)}`);
            }
            const detail = await rest(site, 'GET', `/wp/v2/media/${mediaId}?_fields=id,source_url,mime_type`).catch(() => null) as Record<string, any> | null;
            const sourceUrl = detail?.source_url
              ?? renderCli(await cliExec(site, ['post', 'get', String(mediaId), '--field=guid']), 'wp post get').trim();
            return JSON.stringify({ mediaId, sourceUrl, mime: detail?.mime_type ?? mime, uploaded: true, via: 'cli' });
          } finally {
            await cliRaw(site, `rm -f ${shellQuote(remote)}`).catch(() => {});
          }
        } catch (err) {
          errors.push(`CLI route: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Route 2 — REST multipart (the only route without SSH). Uploads get a
      // longer budget than an ordinary REST call.
      try {
        const created = await rest(site, 'POST', '/wp/v2/media', undefined, {
          headers: { 'Content-Type': mime, 'Content-Disposition': `attachment; filename="${filename}"` },
          raw: new Uint8Array(bytes),
          timeoutMs: UPLOAD_TIMEOUT_MS,
        }) as Record<string, any>;
        if (Object.keys(meta).length && created?.id) {
          await rest(site, 'POST', `/wp/v2/media/${created.id}`, meta).catch(() => {});
        }
        return JSON.stringify({ mediaId: created.id, sourceUrl: created.source_url, mime: created.mime_type ?? mime, uploaded: true, via: 'rest' });
      } catch (err) {
        errors.push(`REST route: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw new Error(
        `wp_upload_media failed on ${site.label}. ${errors.join(' | ')}. ${
          site.ssh ? 'Both routes failed — relay both errors to the human.' : 'This host times out on REST uploads; the reliable route is WP-CLI over SSH (SFTP push + wp media import). Ask the owner to enable SSH for this site in Tools → WordPress Sites.'}`,
      );
    }
    case 'wp_oxygen_replace': {
      const postId = Number(args.post_id);
      const html = String(args.html ?? '');
      if (!Number.isFinite(postId) || postId <= 0 || !html.trim()) {
        throw new Error('wp_oxygen_replace needs post_id and html.');
      }
      const ids = Array.isArray(args.delete_element_ids) ? args.delete_element_ids.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
      const target = await describeTarget(site, { post_id: postId });
      if (target && !target.exists) {
        throw new Error(`wp_oxygen_replace: post ${postId} does not exist on ${site.label}. Verify the id with wp_content_list / oxygen-search-posts.`);
      }
      const steps: string[] = [];
      if (ids.length) {
        const del = await mcpCall(site, 'oxygen-edit-post', { post_id: postId, operations: ids.map(element_id => ({ op: 'delete', payload: { element_id } })) });
        steps.push(`delete ${ids.length} element(s): ${del.slice(0, 600)}`);
      }
      const insertArgs: Record<string, unknown> = { post_id: postId, html };
      if (args.parent_id !== undefined) {
        insertArgs.parent_id = Number(args.parent_id);
      }
      if (args.position !== undefined) {
        insertArgs.position = Number(args.position);
      }
      let ins: string;
      try {
        ins = await mcpCall(site, 'oxygen-html-to-page', insertArgs);
      } catch (err) {
        throw new Error(`${steps.length ? `${steps.join('\n')}\n` : ''}INSERT FAILED after the delete step — the page is now missing that section. Fix by calling oxygen-html-to-page directly. ${err instanceof Error ? err.message : String(err)}`);
      }
      steps.push(`insert: ${ins.slice(0, 1200)}`);
      const where = target?.verified ? `#${postId} "${target.title}" (${target.type}, ${target.status})` : `#${postId}`;
      return `${steps.join('\n')}\n\n[artivio] wrote to ${where}. Fetch the live URL to confirm the section renders once.`;
    }
    case 'wp_read_file': {
      const ssh = requireSsh(site);
      const target = resolveSitePath(ssh.path, args.path);
      const r = await cliRaw(site, `if [ -f ${shellQuote(target.abs)} ]; then head -c ${MAX_SITE_FILE_BYTES} ${shellQuote(target.abs)}; else echo "__ARTIVIO_MISSING__"; fi`);
      if (r.code !== 0) {
        throw new Error(`wp_read_file ${target.rel}: ${r.stderr.trim() || 'read failed'}`);
      }
      if (r.stdout.trim() === '__ARTIVIO_MISSING__') {
        return `No file at ${target.rel} on ${site.label}. (A new file can be created with wp_write_file.)`;
      }
      return r.stdout;
    }
    case 'wp_write_file': {
      const ssh = requireSsh(site);
      const target = resolveSitePath(ssh.path, args.path);
      const content = String(args.content ?? '');
      if (!content.trim()) {
        throw new Error('wp_write_file: content is empty.');
      }
      const bytes = Buffer.from(content, 'utf8');
      if (bytes.length > MAX_SITE_FILE_BYTES) {
        throw new Error(`wp_write_file: ${Math.round(bytes.length / 1024)} KB exceeds the ${MAX_SITE_FILE_BYTES / 1024} KB cap.`);
      }
      if (target.isPhp && !/^\s*<\?php/.test(content)) {
        throw new Error('wp_write_file: a .php file must start with "<?php".');
      }
      const parent = ssh.path.replace(/\/[^/]+$/, '') || '/';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const tmp = `${parent}/artivio-uploads/write-${stamp}-${target.rel.split('/').pop()}`;
      const bak = `${target.abs}.bak-${stamp}`;
      const dir = target.abs.replace(/\/[^/]+$/, '');
      const q = shellQuote;

      // 1. Existence + overwrite gate.
      const exists = (await cliRaw(site, `[ -e ${q(target.abs)} ] && echo yes || echo no`)).stdout.trim() === 'yes';
      if (exists && args.overwrite !== true) {
        throw new Error(`${target.rel} already exists on ${site.label}. Read it first (wp_read_file) and pass overwrite:true to replace it — a backup is kept.`);
      }

      // 2. Push bytes to a temp path outside the web root, syntax-check PHP there.
      renderCli(await cliRaw(site, `mkdir -p ${q(`${parent}/artivio-uploads`)} && chmod 700 ${q(`${parent}/artivio-uploads`)}`), 'mkdir');
      await cliUpload(site, tmp, bytes);
      try {
        if (target.isPhp) {
          const lint = await cliRaw(site, `php -l ${q(tmp)} 2>&1`);
          if (lint.code !== 0 || /Parse error|Fatal error/i.test(lint.stdout + lint.stderr)) {
            throw new Error(`PHP syntax error — nothing was written. php -l says:\n${(lint.stdout + lint.stderr).trim().slice(0, 1500)}`);
          }
        }
        // 3. Back up, move into place.
        const place = [
          `mkdir -p ${q(dir)}`,
          exists ? `cp -p ${q(target.abs)} ${q(bak)}` : 'true',
          `mv ${q(tmp)} ${q(target.abs)}`,
          `chmod 644 ${q(target.abs)}`,
        ].join(' && ');
        renderCli(await cliRaw(site, place), 'write');
      } catch (err) {
        await cliRaw(site, `rm -f ${q(tmp)}`).catch(() => {});
        throw err;
      }

      // 4. Bootstrap WordPress once WITH plugins (an mu-plugin loads
      //    unconditionally). A fatal here means the file must not stay live.
      const boot = await cliExec(site, ['option', 'get', 'blogname']).catch(e => ({ stdout: '', stderr: e instanceof Error ? e.message : String(e), code: 255 }));
      if (boot.code !== 0) {
        const disabled = `${target.abs}.disabled-${stamp}`;
        const undo = exists
          ? `mv ${q(target.abs)} ${q(disabled)} && mv ${q(bak)} ${q(target.abs)}`
          : `mv ${q(target.abs)} ${q(disabled)}`;
        await cliRaw(site, undo).catch(() => {});
        throw new Error(`${target.rel} was written but WordPress FAILED to load with it (exit ${boot.code}: ${(boot.stderr || boot.stdout).trim().slice(0, 800)}). The platform moved it to ${disabled.replace(ssh.path, '')}${exists ? ' and restored the previous version' : ''} so the site stays up. Fix the code and write again.`);
      }
      const flushed = await cliExec(site, ['cache', 'flush']).then(r => r.code === 0).catch(() => false);
      return `Wrote ${target.rel} (${bytes.length} bytes) on ${site.label}${exists ? `; previous version kept at ${bak.replace(ssh.path, '')}` : ''}. ${target.isPhp ? 'php -l passed; WordPress bootstrapped cleanly with it loaded.' : ''} Object cache ${flushed ? 'flushed' : 'flush FAILED'}.${target.rel.startsWith('wp-content/plugins/') ? ' If this is a new plugin, activate it: wp_cli ["plugin","activate","<slug>"].' : ''} Fetch the live page to confirm the effect.`;
    }
    case 'wp_install_plugin': {
      const ssh = requireSsh(site);
      const fileId = String(args.fileId ?? '').trim();
      const row = await getFile(tenantId, fileId);
      if (!row) {
        throw new Error(`No file with id "${fileId}" in this workspace's library — pass the id from list_files, not a URL.`);
      }
      if (row.sizeBytes > MAX_PLUGIN_ZIP_BYTES) {
        throw new Error(`${row.name} is ${Math.round(row.sizeBytes / 1024 / 1024)}MB; plugin zips are capped at ${MAX_PLUGIN_ZIP_BYTES / 1024 / 1024}MB.`);
      }
      const { body } = await getObject(row.r2Key);
      const picked = await pickPluginZip(Buffer.from(body));
      const parent = ssh.path.replace(/\/[^/]+$/, '') || '/';
      const dir = `${parent}/artivio-uploads`;
      const remote = `${dir}/${(picked.dir || row.name.replace(/\.zip$/i, '')).replace(/[^\w.-]+/g, '-').slice(0, 60) || 'plugin'}-${Date.now()}.zip`;
      await cliRaw(site, `mkdir -p ${shellQuote(dir)} && chmod 700 ${shellQuote(dir)}`).then(r => renderCli(r, 'mkdir'));
      await cliUpload(site, remote, picked.bytes);
      try {
        const installArgs = ['plugin', 'install', remote, '--force', ...(args.activate === false ? [] : ['--activate'])];
        const out = renderCli(await cliExec(site, installArgs), 'wp plugin install');
        const flushed = await cliExec(site, ['cache', 'flush']).then(r => r.code === 0).catch(() => false);
        return `${out}\n\n[artivio] installed "${picked.pluginName}"${picked.nestedFrom ? ` (unwrapped from ${picked.nestedFrom} inside the package zip)` : ''}${args.activate === false ? '' : ', activated'}; object cache ${flushed ? 'flushed' : 'flush FAILED'}. Licence keys, if the plugin needs one, are entered by the human in wp-admin.`;
      } finally {
        await cliRaw(site, `rm -f ${shellQuote(remote)}`).catch(() => {});
      }
    }
    case 'wp_seo_get':
      return JSON.stringify(await rest(site, 'GET', `/artivio/v1/documents/${Number(args.id)}/seo`));
    case 'wp_seo_update': {
      const FIELDS = ['title', 'description', 'focusKeyword', 'canonical', 'breadcrumbTitle', 'ogTitle', 'ogDescription', 'ogImage', 'twitterTitle', 'twitterDescription', 'twitterImage', 'noindex', 'nofollow'] as const;
      const body: Record<string, unknown> = {};
      for (const f of FIELDS) {
        if (args[f] !== undefined) {
          body[f] = args[f];
        }
      }
      if (Object.keys(body).length === 0) {
        throw new Error(`wp_seo_update needs at least one field. Valid: ${FIELDS.join(', ')}.`);
      }
      return JSON.stringify(await rest(site, 'PATCH', `/artivio/v1/documents/${Number(args.id)}/seo`, body));
    }
    case 'wp_cache_flush': {
      const steps: string[] = [];
      const run = async (label: string, argv: string[], optional = false) => {
        try {
          steps.push(`${label}: ${renderCli(await cliExec(site, argv), label).split('\n')[0]}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          steps.push(optional ? `${label}: skipped (${msg.split('.')[0]})` : `${label}: FAILED — ${msg}`);
        }
      };
      await run('object cache', ['cache', 'flush']);
      await run('transients', ['transient', 'delete', '--all']);
      await run('rewrite rules', ['rewrite', 'flush']);
      await run('LiteSpeed page cache', ['litespeed-purge', 'all'], true);
      return steps.join('\n');
    }
    case 'wp_search_replace': {
      const search = String(args.search ?? '');
      const replace = String(args.replace ?? '');
      if (!search) {
        throw new Error('search is required.');
      }
      const dryRun = args.dry_run !== false;
      const argv = ['search-replace', search, replace];
      if (Array.isArray(args.tables) && args.tables.length > 0) {
        argv.push(...(args.tables as unknown[]).map(String));
      }
      argv.push('--skip-columns=guid', '--report-changed-only');
      if (args.all_tables === true) {
        argv.push('--all-tables');
      }
      if (dryRun) {
        argv.push('--dry-run');
      }
      const ssh = requireSsh(site);
      const result = dryRun
        ? await cliExec(site, argv)
        : await cliRaw(site, ['wp', `--path=${ssh.path}`, '--no-color', ...argv].map(shellQuote).join(' '));
      const body = renderCli(result, dryRun ? 'wp search-replace (dry run)' : 'wp search-replace (LIVE)');
      return dryRun
        ? `DRY RUN — nothing changed. Per-table counts of what WOULD change:\n${body}\n\nTo apply, call again with dry_run:false after the human has seen these counts (and take wp_snapshot first).`
        : `LIVE search-replace applied:\n${body}\n\nRun wp_cache_flush so the change is visible.`;
    }
    default:
      throw new Error(`WordPress Sites: unknown tool ${tool}`);
  }
}

// ─── Provider ────────────────────────────────────────────────────────────────

export const wpSitesProvider: BuiltinProvider = {
  slug: 'wp-sites',
  name: 'WordPress Sites',
  description: 'Every WordPress site a workspace owns, in one connector: REST, the site\'s MCP abilities (Oxygen Agent Connector, MCP Adapter) and WP-CLI over SSH, addressed by label. Two credentials per site — application password + SSH key — everything else is discovered. Replaces the separate WordPress and WP-CLI plugins.',
  credentialLabel: 'None on the connection — sites and their credentials are added in Tools → WordPress Sites after enabling.',
  noCredential: true,

  guidance: `WordPress Sites connection (tools wp_*):
- Sites are addressed by LABEL via the \`site\` argument. With one site (or a default) it can be omitted; with several and no default you MUST pass it — if the task did not name the site, ask the human rather than guess. Call wp_sites to see labels, health and what each site can do.
- Three channels per site. REST (wp_rest + the wp_content_* / wp_seo_* tools) works on every site. MCP (wp_mcp_tools / wp_mcp) is how page-builder layouts are edited when the site exposes builder abilities (oxygen/*, bricks/*). CLI (wp_cli, wp_cache_flush, wp_search_replace, wp_snapshot) runs on the host and changes the live site the moment it runs.
- A builder page edited through post_content saves successfully and changes NOTHING visible. Check wp_sites → builder first. Oxygen/Bricks: use the site's MCP abilities. Elementor: the Elementor connection. Divi: the DiviOps connection. Block editor (gutenberg): wp_content_* is right.
- Reads never need approval; writes follow the site's per-channel policy (Auto-run / Ask first / Blocked). A refusal that names a policy is the owner's decision, not an error to work around.
- Before bulk or destructive changes (live search-replace, plugin updates, builder-wide edits) call wp_snapshot on that site. Builder tree edits are not transactional.
- When a channel fails, call wp_site_status on that site: it says which of credential / plugin / SSH key / path is wrong and how to fix it. Relay that; do not invent steps.
- Posts and pages are SEPARATE collections. wp_content_create requires type. Drafts by default; publish only when a human said so in this conversation.
- Never ask the human for a token, header, application password or SSH key — secrets live in Tools → WordPress Sites and you never see them.
- MCP ability names are EXACT and come from wp_mcp_tools — never guess or shorten one (there is no "html-to-page" or "oxygen-add-css"; the Oxygen ones are "oxygen-html-to-page", "oxygen-insert-stylesheet", "oxygen-insert-css-variables"…). Pass wp_mcp args as a JSON object, never as a string.
- Oxygen: to REWRITE a section use wp_oxygen_replace (delete ids + insert HTML in one call). "oxygen-html-to-page" APPENDS to the page tree — every call adds sections. Use its position argument to insert where you mean, and to redo a section read the tree with "oxygen-get-post-tree" {post_id} first and remove the old elements with "oxygen-edit-post" delete ops (one op per top-level element) BEFORE writing. Never call html-to-page twice on the same page expecting a replace. "oxygen-get-post-tree" takes only post_id (no context).
- Page ids in your notes GO STALE (pages get recreated with new ids). Before a builder write, confirm the id with wp_content_get and check the TITLE is the page you mean; every wp_mcp write reports "[artivio] wrote to #id "Title"" — read it. After building a page, fetch_url its live URL: a page that shows only header and footer is BLANK and the work is not done.
- Oxygen headers/footers/templates (oxygen_header, oxygen_footer, oxygen_template) are edited with the SAME abilities as pages (oxygen-edit-post, oxygen-html-to-page, wp_oxygen_replace) using the template's post id from oxygen-search-posts. Never edit _oxygen_data postmeta by hand through wp_cli — one malformed write corrupts the whole template.
- Oxygen layout (height, position, background) is set through the element's DESIGN properties with an oxygen-edit-post update op — read oxygen-get-element-schemas for the property path first. Injected CSS and <style> blocks lose to Oxygen's own rules; do not fight specificity with more CSS.
- Images on a site must be site-hosted: wp_upload_media (returns source_url) — never a workspace library URL in a layout.
- Site-level PHP (a filter, a CPT registration, a compatibility fix): wp_write_file to wp-content/mu-plugins/<name>.php — never wp eval / eval-file (refused, by design). Read an existing file with wp_read_file before overwriting it. The platform syntax-checks PHP and disables the file automatically if WordPress fails to load with it.
- Premium plugin zips: wp_install_plugin with the library file id. Do NOT try wp plugin install with a library URL (private, 404) or via the Media Library (.zip is rejected).`,

  guidanceFor: async ({ tenantId }) => {
    const sites = await listSites(tenantId);
    if (sites.length === 0) {
      return 'No WordPress sites are registered yet — the owner adds them in Tools → WordPress Sites.';
    }
    return `Registered sites: ${sites.map(s => `${s.label}${s.isDefault ? ' (default)' : ''} [${s.builder ?? 'untested'}; ${s.status}${s.capabilities.mcp ? '; mcp' : ''}${s.capabilities.cli ? '; cli' : ''}]`).join(', ')}.`;
  },

  policyFor: async (tool, args, { tenantId }): Promise<ToolPolicy | undefined> => {
    const { channel, write } = classify(tool, args);
    if (channel === 'meta') {
      return 'auto';
    }
    // F4: a hard-denied WP-CLI command (db drop, eval…) must never sit in a
    // human's approval inbox waiting for a mis-click. Let it run — cliExec's
    // assertArgsSafe refuses it before SSH with the platform-rule message, so
    // "auto" here means "fail immediately with the reason", not "execute".
    if (tool === 'wp_cli') {
      try {
        assertArgsSafe(normaliseArgv(args.args));
      } catch {
        return 'auto';
      }
    }
    const site = await resolveSiteByLabel(tenantId, typeof args.site === 'string' ? args.site : undefined)
      // Unresolvable site → let the call run so the agent gets the helpful
      // "no site labelled X, available: …" error instead of an approval row.
      .catch(() => null);
    if (!site) {
      return 'auto';
    }
    return toToolPolicy(site.policy, channel, write);
  },

  tools,

  call: async (tool, args, _credential, _target, ctx): Promise<string> => {
    const tenantId = ctx?.tenantId;
    if (!tenantId) {
      throw new Error('WordPress Sites: no workspace context on this call.');
    }
    const { channel, write } = classify(tool, args);
    const site = tool === 'wp_sites'
      ? null
      : await resolveSiteByLabel(tenantId, typeof args.site === 'string' ? args.site : undefined);
    if (site && channel !== 'meta' && site.policy[channel] === 'blocked') {
      // Belt and braces: policyFor already denies; a replayed approval must not slip through.
      throw new Error(`WordPress Sites: the ${channel.toUpperCase()} channel is Blocked on site "${site.label}" by the workspace owner. This is a policy, not a fault.`);
    }
    const started = Date.now();
    const run = () => execute(tool, args, tenantId, site);
    try {
      // Writes (and CLI housekeeping) are serialised per site; reads run in parallel.
      const out = site && (write || channel === 'cli') ? await serialisedForSite(site.id, run) : await run();
      if (site) {
        await logSiteCall({ tenantId, siteId: site.id, label: site.label, channel, tool, args, ok: true, durationMs: Date.now() - started });
      }
      return out;
    } catch (err) {
      if (site) {
        await logSiteCall({ tenantId, siteId: site.id, label: site.label, channel, tool, args, ok: false, durationMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
      }
      throw err;
    }
  },
};
