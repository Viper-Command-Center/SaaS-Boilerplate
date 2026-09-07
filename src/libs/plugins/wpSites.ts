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
import { cliExec, cliRaw, explainRestFailure, mcpCall, mcpListTools, renderCli, requireSsh, restRequest } from '@/libs/wpsites/channels';
import { formatReport, runSiteTest } from '@/libs/wpsites/discovery';
import { cliIsWrite, restIsWrite, serialisedForSite, toToolPolicy } from '@/libs/wpsites/policy';
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
    return raw.trim().replace(/^wp\s+/, '').split(/\s+/).filter(Boolean);
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
    description: 'Upload an image/PDF/video from the workspace file library into the site\'s Media Library. Pass the LIBRARY FILE ID (from list_files, extract_document_images, save_file_from_url) — never a URL or bytes. Returns the WordPress media id (featuredMediaId) and the site-hosted source_url for <img> tags.',
    input_schema: {
      type: 'object',
      properties: { ...SITE_ARG, fileId: { type: 'string' }, title: { type: 'string' }, altText: { type: 'string' }, caption: { type: 'string' } },
      required: ['fileId'],
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
    case 'wp_snapshot':
    case 'wp_cache_flush':
      // Protective / housekeeping: they change nothing a visitor sees. Reads
      // for policy purposes, still serialised with writes below.
      return { channel: 'cli', write: false };
    case 'wp_search_replace':
      return { channel: 'cli', write: args.dry_run === false };
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

async function rest(site: ResolvedSite, method: string, route: string, body?: unknown, init?: { headers?: Record<string, string>; raw?: BodyInit }) {
  const r = await restRequest(site, method, route, body, init);
  if (!r.ok) {
    throw new Error(explainRestFailure(site, r, route));
  }
  return r.body;
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
      const a = (args.args && typeof args.args === 'object') ? args.args as Record<string, unknown> : {};
      return mcpCall(site, name, a);
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
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${msg}\nDiagnose with wp_cli ["db","check"] and wp_cli ["db","export","-","--skip-plugins","--skip-themes","--no-tablespaces","--tables=wp_options"] (dumps one table to stdout). `
          + 'If that works the folder is the problem; if it fails the message names the mysqldump error. Report it to the human; do not skip the snapshot silently.',
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
      const created = await rest(site, 'POST', '/wp/v2/media', undefined, {
        headers: { 'Content-Type': mime, 'Content-Disposition': `attachment; filename="${filename}"` },
        raw: new Uint8Array(bytes),
      }) as Record<string, any>;
      const meta = {
        ...(args.title ? { title: String(args.title) } : {}),
        ...(args.altText ? { alt_text: String(args.altText) } : {}),
        ...(args.caption ? { caption: String(args.caption) } : {}),
      };
      if (Object.keys(meta).length && created?.id) {
        await rest(site, 'POST', `/wp/v2/media/${created.id}`, meta).catch(() => {});
      }
      return JSON.stringify({ mediaId: created.id, sourceUrl: created.source_url, mime: created.mime_type ?? mime, uploaded: true });
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
- Never ask the human for a token, header, application password or SSH key — secrets live in Tools → WordPress Sites and you never see them.`,

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
