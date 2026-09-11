/**
 * Discovery + the Test button (Phase 34 §5–§6).
 *
 * Runs on Save and on Test. Channel by channel, each check produces one row
 * (✅ / ⚠️ / ❌) with a one-line detail and a remediation hint, and along the
 * way fills the site's discovered fields: MCP endpoint, WP/PHP versions, the
 * page builder, plugin versions, the agent user's roles.
 *
 * Nothing here is typed in by the user: two credentials in, everything else
 * is read off the site. Builder and plugin facts are cross-checked from up to
 * three sources (REST namespaces, MCP tool prefixes, WP-CLI plugin list) so a
 * site with only one channel working still gets a truthful answer.
 */

import type { Discovered } from '@/libs/wpsites/store';
import type { Builder, ResolvedSite, SiteCapabilities, SiteStatus, TestReport, TestRow } from '@/libs/wpsites/types';
import { cliExec, mcpClientFor, renderCli, restRequest } from '@/libs/wpsites/channels';
import { redactSecrets } from '@/libs/wpsites/redact';
import { getResolvedSite, storeTestResult } from '@/libs/wpsites/store';
import { EMPTY_CAPABILITIES } from '@/libs/wpsites/types';

/** Oldest Agent Connector / MCP Adapter we know speaks the protocol we use. */
export const MIN_AGENT_CONNECTOR_VERSION = '0.1.0';

export type TestOptions = {
  /** Create + delete a draft "_artivio_probe" over REST to prove writes work. */
  writeProbe?: boolean;
};

type Ctx = {
  site: ResolvedSite;
  rows: TestRow[];
  caps: SiteCapabilities;
  discovered: Discovered;
};

function row(ctx: Ctx, r: TestRow) {
  ctx.rows.push(r);
}

function errMsg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 240);
}

// ─── Builder detection ───────────────────────────────────────────────────────

const BUILDER_NAMESPACE_HINTS: Array<[RegExp, Builder]> = [
  [/^oxygen/i, 'oxygen'],
  [/^bricks/i, 'bricks'],
  [/^elementor/i, 'elementor'],
  [/^divi|^et[-_]/i, 'divi'],
];

const BUILDER_PLUGIN_HINTS: Array<[RegExp, Builder]> = [
  [/^oxygen/i, 'oxygen'],
  [/^bricks/i, 'bricks'],
  [/^elementor$/i, 'elementor'],
  [/^divi|^et-builder/i, 'divi'],
];

export function detectBuilder(input: {
  namespaces?: string[];
  mcpTools?: string[];
  plugins?: Array<{ name: string; version?: string }>;
  themes?: Array<{ name: string; status?: string }>;
  basePluginBuilder?: string | null;
}): { builder: Builder; version: string | null; abilities: string[] } {
  // 1. The base plugin already knows (it reads the active theme + plugin list).
  const fromBase = (input.basePluginBuilder ?? '').toLowerCase();
  let builder: Builder | null = (['oxygen', 'divi', 'bricks', 'elementor'] as Builder[]).find(b => fromBase.includes(b)) ?? null;

  // 2. MCP tool prefixes — the strongest signal that a builder is AGENT-ready.
  const abilities: string[] = [];
  for (const t of input.mcpTools ?? []) {
    for (const [re, b] of BUILDER_NAMESPACE_HINTS) {
      if (re.test(t)) {
        abilities.push(t);
        builder ??= b;
      }
    }
  }
  // 3. REST namespaces (elementor/v1, oxygen/v1, bricks/v1…).
  if (!builder) {
    for (const ns of input.namespaces ?? []) {
      for (const [re, b] of BUILDER_NAMESPACE_HINTS) {
        if (re.test(ns)) {
          builder = b;
        }
      }
    }
  }
  // 4. Active plugin / theme slugs from WP-CLI.
  let version: string | null = null;
  for (const p of input.plugins ?? []) {
    for (const [re, b] of BUILDER_PLUGIN_HINTS) {
      if (re.test(p.name)) {
        builder ??= b;
        if (builder === b && p.version) {
          version = p.version;
        }
      }
    }
  }
  if (!builder) {
    const divi = (input.themes ?? []).find(t => /^divi$/i.test(t.name) && t.status === 'active');
    if (divi) {
      builder = 'divi';
    }
  }
  return { builder: builder ?? 'gutenberg', version, abilities };
}

// ─── MCP endpoint discovery ──────────────────────────────────────────────────

/**
 * Find the site's MCP endpoint in /wp-json/ index. The WordPress MCP Adapter
 * registers `mcp/mcp-adapter-default`; Oxygen's Agent Connector and others
 * register their own under an `mcp…` namespace. Prefer the adapter's default,
 * then the shortest parameter-free route — never a route with a regex.
 */
export function findMcpRoute(index: { namespaces?: string[]; routes?: Record<string, unknown> }): string | null {
  const routes = Object.keys(index.routes ?? {});
  const candidates = routes.filter(r => /^\/mcp(?:[-_/]|$)/i.test(r) && !/[()?<]/.test(r) && r !== '/mcp');
  if (candidates.length === 0) {
    // Some plugins register the namespace but list the endpoint elsewhere.
    const ns = (index.namespaces ?? []).find(n => /^mcp(?:[/-]|$)/i.test(n));
    return ns ? `/${ns.replace(/\/+$/, '')}/mcp` : null;
  }
  candidates.sort((a, b) => {
    const pa = /adapter-default/i.test(a) ? 0 : 1;
    const pb = /adapter-default/i.test(b) ? 0 : 1;
    return pa - pb || a.length - b.length;
  });
  return candidates[0]!;
}

/**
 * Numeric dotted compare. Tolerates a "v" prefix and pre-release suffixes
 * ("v1.0.0", "6.2.0-beta.8"): the MCP Adapter reports "v1.0.0", and
 * `parseInt('v1')` is NaN → 0, which made 1.0.0 read as 0.0.0 and told Ryan
 * to update a plugin that was already current (2026-09-06).
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/i, '').split(/[-+]/)[0]!.split('.').map(n => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

// ─── The checks ──────────────────────────────────────────────────────────────

/**
 * http → https on the SAME host is a scheme upgrade, not a failure. Requests
 * never follow redirects (an Authorization header must not travel to a host
 * the owner did not name), so the test upgrades the stored URL itself and
 * says so. BBI (2026-09-08): site entered as http://, /wp-json/ answered 301,
 * report said "check DNS, TLS, maintenance mode" — none of which was wrong.
 */
export function httpsUpgradeOf(siteUrl: string, status: number, location: string | undefined): string | null {
  if (![301, 302, 307, 308].includes(status) || !location) {
    return null;
  }
  try {
    const from = new URL(siteUrl);
    const to = new URL(location, siteUrl);
    if (from.protocol === 'http:' && to.protocol === 'https:' && to.hostname === from.hostname) {
      return `https://${to.host}`;
    }
  } catch { /* not a URL */ }
  return null;
}

async function checkReachability(ctx: Ctx): Promise<{ namespaces: string[]; routes: Record<string, unknown> } | null> {
  try {
    let r = await restRequest(ctx.site, 'GET', '/');
    const upgraded = httpsUpgradeOf(ctx.site.siteUrl, r.status, r.headers.location ?? r.headers.Location);
    if (upgraded) {
      ctx.site = { ...ctx.site, siteUrl: upgraded };
      ctx.discovered.siteUrl = upgraded;
      row(ctx, { check: 'Site URL', status: 'ok', detail: `${upgraded} — the site redirects http→https; the stored URL was upgraded.` });
      r = await restRequest(ctx.site, 'GET', '/');
    }
    if (!r.ok || typeof r.body !== 'object' || !r.body) {
      const loc = r.headers.location ?? r.headers.Location;
      row(ctx, {
        check: 'Reachability',
        status: 'fail',
        detail: `/wp-json/ answered HTTP ${r.status}${loc ? ` → ${loc}` : ''}`,
        hint: loc
          ? 'The site redirects to a different host or path. Enter the site URL exactly as WordPress → Settings → General shows it (scheme and host).'
          : 'Check DNS, TLS, maintenance mode, or a security plugin blocking the REST API.',
      });
      return null;
    }
    const idx = r.body as { namespaces?: string[]; routes?: Record<string, unknown>; name?: string };
    ctx.caps.namespaces = Array.isArray(idx.namespaces) ? idx.namespaces.map(String) : [];
    ctx.caps.rest = true;
    row(ctx, { check: 'Reachability', status: 'ok', detail: `${idx.name ? `"${idx.name}" — ` : ''}${ctx.caps.namespaces.length} REST namespaces` });
    return { namespaces: ctx.caps.namespaces, routes: idx.routes ?? {} };
  } catch (err) {
    row(ctx, { check: 'Reachability', status: 'fail', detail: errMsg(err), hint: 'Check DNS, TLS (an expired certificate fails here), or maintenance mode.' });
    return null;
  }
}

async function checkRestAuth(ctx: Ctx): Promise<boolean> {
  try {
    const r = await restRequest(ctx.site, 'GET', '/wp/v2/users/me?context=edit');
    if (r.status === 401 || r.status === 403) {
      row(ctx, { check: 'REST auth', status: 'fail', detail: `users/me answered HTTP ${r.status}`, hint: ctx.site.authScheme === 'basic' ? 'Wrong username or application password — use Rotate, or create a new application password in WP Admin → Users → Profile.' : 'The token was rejected — re-issue it in the site plugin.' });
      return false;
    }
    if (!r.ok || typeof r.body !== 'object' || !r.body) {
      row(ctx, { check: 'REST auth', status: 'fail', detail: `users/me answered HTTP ${r.status}`, hint: 'The REST API is reachable but authentication did not run — check that Application Passwords are enabled (they are off on some hosts over plain http).' });
      return false;
    }
    const me = r.body as { name?: string; slug?: string; roles?: string[]; capabilities?: Record<string, boolean> };
    const roles = Array.isArray(me.roles) ? me.roles.map(String) : [];
    ctx.caps.roles = roles;
    row(ctx, { check: 'REST auth', status: 'ok', detail: `Authenticated as ${me.slug ?? me.name ?? ctx.site.authUser ?? 'user'}` });
    if (roles.includes('administrator') || me.capabilities?.manage_options) {
      row(ctx, { check: 'Role', status: 'ok', detail: `roles: ${roles.join(', ') || 'administrator'}` });
    } else {
      row(ctx, { check: 'Role', status: 'warn', detail: `roles: ${roles.join(', ') || 'none reported'}`, hint: 'The agent user needs Administrator for builder abilities and plugin management. Content-only tasks work with Editor.' });
    }
    return true;
  } catch (err) {
    row(ctx, { check: 'REST auth', status: 'fail', detail: errMsg(err) });
    return false;
  }
}

async function readAppPasswordUuid(ctx: Ctx) {
  if (ctx.site.authScheme !== 'basic') {
    return;
  }
  try {
    const r = await restRequest(ctx.site, 'GET', '/wp/v2/users/me/application-passwords/introspect');
    if (r.ok && typeof r.body === 'object' && r.body && typeof (r.body as { uuid?: string }).uuid === 'string') {
      ctx.discovered.appPasswordUuid = (r.body as { uuid: string }).uuid;
    }
  } catch { /* optional */ }
}

async function checkBasePlugin(ctx: Ctx): Promise<{ builder?: string | null; builderVersion?: string | null; wp?: string; php?: string; plugins?: string[] }> {
  if (!ctx.caps.namespaces.some(n => n.startsWith('artivio/'))) {
    row(ctx, { check: 'Artivio base plugin', status: 'warn', detail: 'artivio-wp-agent not installed', hint: 'Optional. It adds SEO fields, site diagnostics and the provisioning hook — upload wordpress-plugins/artivio-wp-agent.zip once.' });
    return {};
  }
  try {
    const r = await restRequest(ctx.site, 'GET', '/artivio/v1/site');
    if (!r.ok || typeof r.body !== 'object' || !r.body) {
      row(ctx, { check: 'Artivio base plugin', status: 'warn', detail: `/artivio/v1/site answered HTTP ${r.status}` });
      return {};
    }
    // Shape per wordpress-plugins/artivio-wp-agent (artivio_wp_site()):
    // { pluginVersion, wp, php, builders: {elementor|divi|bricks|oxygen|beaverBuilder: version}, theme, restNamespaces, roles }
    const s = r.body as Record<string, any>;
    ctx.caps.base_plugin = true;
    const wp = typeof s.wp === 'string' ? s.wp : undefined;
    const php = typeof s.php === 'string' ? s.php : undefined;
    const builders = (s.builders && typeof s.builders === 'object') ? s.builders as Record<string, string> : {};
    const builderName = Object.keys(builders).find(k => /^(?:oxygen|divi|bricks|elementor)$/i.test(k)) ?? null;
    const plugins: string[] = builderName ? [builderName] : [];
    row(ctx, { check: 'Artivio base plugin', status: 'ok', detail: `v${s.pluginVersion ?? '?'}${wp ? ` · WP ${wp}` : ''}${php ? ` · PHP ${php}` : ''}${builderName ? ` · ${builderName} ${builders[builderName]}` : ''}` });
    return { builder: builderName, builderVersion: builderName ? String(builders[builderName]) : null, wp, php, plugins };
  } catch (err) {
    row(ctx, { check: 'Artivio base plugin', status: 'warn', detail: errMsg(err) });
    return {};
  }
}

/**
 * Per-builder MCP remediation. Falls back to the builder-agnostic Adapter
 * when no known builder is detected — e.g. Gutenberg + ACF 6.8's Abilities
 * API, which needs the Adapter plugin to expose an actual MCP route. Ryan
 * (2026-09-11): the old hint hardcoded "install Oxygen's Agent Connector"
 * even on a plain block-editor site with no Oxygen involved.
 */
export function mcpMissingHint(builder: string | null | undefined): string {
  switch (builder) {
    case 'oxygen': {
      return 'Install Oxygen\'s Agent Connector (Oxygen → Settings → Agents & MCP), then Test again.';
    }
    case 'elementor': {
      return 'Install Elementor\'s Angie plugin (wordpress.org/plugins/angie), then Test again.';
    }
    case 'divi': {
      return 'Divi layouts are edited through the DiviOps connection, not MCP — no adapter plugin needed for Divi itself.';
    }
    case 'bricks': {
      return 'Enable Bricks\' built-in AI/MCP integration (Bricks ≥ 2.4, Settings → AI Permissions), then Test again.';
    }
    default: {
      return 'No builder-specific MCP plugin detected. Install the official WordPress MCP Adapter plugin (wordpress/mcp-adapter) — it exposes any Abilities-API-registered plugin (e.g. ACF ≥ 6.8) as an MCP endpoint — then Test again.';
    }
  }
}

async function checkMcp(ctx: Ctx, index: { namespaces: string[]; routes: Record<string, unknown> } | null, builderHint?: string | null): Promise<string[]> {
  const route = index ? findMcpRoute(index) : null;
  if (!route) {
    ctx.discovered.mcpEndpointUrl = null;
    ctx.caps.mcp = false;
    row(ctx, { check: 'MCP endpoint', status: 'fail', detail: 'No mcp/* route in /wp-json/', hint: mcpMissingHint(builderHint) });
    return [];
  }
  const endpoint = `${ctx.site.siteUrl}/wp-json${route}`;
  ctx.discovered.mcpEndpointUrl = endpoint;
  const probe: ResolvedSite = { ...ctx.site, mcpEndpointUrl: endpoint };
  try {
    const client = mcpClientFor(probe);
    const tools = await client.listTools();
    ctx.caps.mcp = true;
    ctx.caps.mcp_tools = tools.map(t => t.name);
    const info = client.serverInfo;
    row(ctx, { check: 'MCP endpoint', status: 'ok', detail: `${route}${info?.name ? ` — ${info.name}${info.version ? ` ${info.version}` : ''}` : ''}` });
    if (tools.length === 0) {
      row(ctx, { check: 'MCP tools', status: 'warn', detail: 'tools/list returned 0 tools', hint: 'Enable abilities in the plugin (Agent Connector → Abilities; MCP Adapter → exposed abilities).' });
    } else {
      row(ctx, { check: 'MCP tools', status: 'ok', detail: `${tools.length} tools: ${tools.slice(0, 6).map(t => t.name).join(', ')}${tools.length > 6 ? '…' : ''}` });
    }
    if (info?.version) {
      ctx.discovered.agentConnectorVersion = info.version;
      if (compareVersions(info.version, MIN_AGENT_CONNECTOR_VERSION) < 0) {
        row(ctx, { check: 'Agent Connector', status: 'warn', detail: `${info.name ?? 'server'} ${info.version} < ${MIN_AGENT_CONNECTOR_VERSION}`, hint: 'Update the plugin.' });
      } else {
        row(ctx, { check: 'Agent Connector', status: 'ok', detail: `${info.name ?? 'MCP server'} ${info.version}` });
      }
    }
    return ctx.caps.mcp_tools;
  } catch (err) {
    ctx.caps.mcp = false;
    const m = errMsg(err);
    row(ctx, { check: 'MCP endpoint', status: 'fail', detail: `${route}: ${m}`, hint: /401|403/.test(m) ? 'The MCP plugin rejected the credential — its own auth setting may require a separate token (Advanced → custom bearer token).' : 'The route exists but initialize failed — check the plugin is active and a cache/WAF is not intercepting POSTs to /wp-json/mcp/.' });
    return [];
  }
}

async function checkCache(ctx: Ctx) {
  const endpoint = ctx.discovered.mcpEndpointUrl;
  if (!endpoint) {
    return;
  }
  try {
    const r = await restRequest(ctx.site, 'GET', endpoint, undefined, { timeoutMs: 10_000 });
    const ls = r.headers['x-litespeed-cache'] ?? '';
    const cf = r.headers['cf-cache-status'] ?? '';
    const hit = /hit/i.test(ls) || /^hit$/i.test(cf);
    const age = r.headers.age;
    if (hit || (age && Number(age) > 0)) {
      row(ctx, { check: 'Cache', status: 'warn', detail: `MCP endpoint served from cache (${ls ? `x-litespeed-cache: ${ls}` : `cf-cache-status: ${cf || `age ${age}`}`})`, hint: 'Exclude /wp-json/mcp/ from LiteSpeed Cache / Cloudflare page rules — cached responses break MCP sessions.' });
    } else {
      row(ctx, { check: 'Cache', status: 'ok', detail: `GET answered HTTP ${r.status}, not cached` });
    }
  } catch (err) {
    row(ctx, { check: 'Cache', status: 'warn', detail: errMsg(err) });
  }
}

async function checkCli(ctx: Ctx): Promise<{ plugins: Array<{ name: string; version?: string; status?: string }>; themes: Array<{ name: string; status?: string }>; wp?: string; php?: string }> {
  const empty = { plugins: [] as Array<{ name: string; version?: string; status?: string }>, themes: [] as Array<{ name: string; status?: string }> };
  if (!ctx.site.ssh) {
    row(ctx, { check: 'SSH', status: 'skip', detail: 'WP-CLI channel not enabled' });
    return empty;
  }
  try {
    const info = renderCli(await cliExec(ctx.site, ['cli', 'info']), 'wp cli info');
    const php = /PHP version:\s*(\S+)/i.exec(info)?.[1];
    row(ctx, { check: 'SSH', status: 'ok', detail: `${ctx.site.ssh.user}@${ctx.site.ssh.host}:${ctx.site.ssh.port} — ${/WP-CLI version:\s*(\S+)/i.exec(info)?.[1] ? `WP-CLI ${/WP-CLI version:\s*(\S+)/i.exec(info)?.[1]}` : 'wp --info ok'}` });
    if (php) {
      ctx.discovered.phpVersion = php;
    }
    try {
      const version = renderCli(await cliExec(ctx.site, ['core', 'version']), 'wp core version').trim();
      ctx.caps.cli = true;
      ctx.discovered.wpVersion = version;
      row(ctx, { check: 'WP-CLI path', status: 'ok', detail: `WordPress ${version} at ${ctx.site.ssh.path}` });
    } catch (err) {
      row(ctx, { check: 'WP-CLI path', status: 'fail', detail: errMsg(err), hint: 'Fix the WP path — it must be the folder that contains wp-config.php.' });
      return { ...empty, php };
    }
    let plugins = empty.plugins;
    let themes = empty.themes;
    try {
      plugins = JSON.parse(renderCli(await cliExec(ctx.site, ['plugin', 'list', '--status=active', '--format=json', '--fields=name,version,status']), 'wp plugin list'));
      ctx.caps.plugins = plugins.map(p => p.name);
    } catch { /* non-fatal */ }
    try {
      themes = JSON.parse(renderCli(await cliExec(ctx.site, ['theme', 'list', '--format=json', '--fields=name,status,version']), 'wp theme list'));
    } catch { /* non-fatal */ }
    return { plugins, themes, php };
  } catch (err) {
    const m = errMsg(err);
    row(ctx, {
      check: 'SSH',
      status: 'fail',
      detail: m,
      hint: /authentication/i.test(m)
        ? 'The workspace public key is not added on the host (Hostinger: Websites → Advanced → SSH Access → Add SSH key), or SSH is disabled on the plan.'
        : /timed out/i.test(m) ? 'Wrong host or port, or SSH is not enabled on the hosting plan.' : 'Check host, port and user.',
    });
    return empty;
  }
}

async function writeProbe(ctx: Ctx) {
  try {
    const created = await restRequest(ctx.site, 'POST', '/wp/v2/posts', { title: '_artivio_probe', status: 'draft', content: 'Connectivity probe — safe to delete.' });
    if (!created.ok) {
      row(ctx, { check: 'Write probe', status: 'fail', detail: `create draft answered HTTP ${created.status}`, hint: 'The user cannot create content — check its role, or a read-only/staging lock on the site.' });
      return;
    }
    const id = (created.body as { id?: number }).id;
    if (id) {
      await restRequest(ctx.site, 'DELETE', `/wp/v2/posts/${id}?force=true`);
    }
    row(ctx, { check: 'Write probe', status: 'ok', detail: `draft #${id ?? '?'} created and deleted` });
  } catch (err) {
    row(ctx, { check: 'Write probe', status: 'fail', detail: errMsg(err) });
  }
}

function overallStatus(rows: TestRow[]): SiteStatus {
  const restAuth = rows.find(r => r.check === 'REST auth');
  if (!restAuth || restAuth.status === 'fail' || rows.find(r => r.check === 'Reachability')?.status === 'fail') {
    return 'failed';
  }
  if (rows.some(r => r.status === 'fail' || r.status === 'warn')) {
    return 'degraded';
  }
  return 'healthy';
}

// ─── Entry points ────────────────────────────────────────────────────────────

export async function discoverAndTest(site: ResolvedSite, opts: TestOptions = {}): Promise<{ discovered: Discovered; report: TestReport }> {
  const started = Date.now();
  const ctx: Ctx = {
    site,
    rows: [],
    caps: { ...EMPTY_CAPABILITIES, builder_abilities: [], plugins: [], mcp_tools: [], namespaces: [], roles: [] },
    discovered: { capabilities: EMPTY_CAPABILITIES },
  };

  const index = await checkReachability(ctx);
  const authed = index ? await checkRestAuth(ctx) : false;
  let base: Awaited<ReturnType<typeof checkBasePlugin>> = {};
  let mcpTools: string[] = [];
  if (authed) {
    await readAppPasswordUuid(ctx);
    base = await checkBasePlugin(ctx);
    mcpTools = await checkMcp(ctx, index, base.builder ?? null);
    await checkCache(ctx);
  }
  // CLI is independent of REST — a wrong app password must not hide an SSH fault.
  const cli = await checkCli(ctx);

  const det = detectBuilder({
    namespaces: ctx.caps.namespaces,
    mcpTools,
    plugins: cli.plugins.length > 0 ? cli.plugins : (base.plugins ?? []).map(name => ({ name })),
    themes: cli.themes,
    basePluginBuilder: base.builder ?? null,
  });
  ctx.caps.builder_abilities = det.abilities;
  if (cli.plugins.length === 0 && base.plugins?.length) {
    ctx.caps.plugins = base.plugins;
  }
  ctx.discovered.builder = det.builder;
  ctx.discovered.builderVersion = det.version ?? base.builderVersion ?? null;
  ctx.discovered.wpVersion ??= base.wp ?? null;
  ctx.discovered.phpVersion ??= base.php ?? cli.php ?? null;

  if (authed) {
    if (det.builder === 'gutenberg' || det.builder === 'none') {
      row(ctx, { check: 'Builder', status: 'ok', detail: 'No page builder detected (block editor) — content tools apply.' });
    } else if (det.abilities.length > 0) {
      row(ctx, { check: 'Builder', status: 'ok', detail: `${det.builder}${det.version ? ` ${det.version}` : ''} — ${det.abilities.length} MCP abilities` });
    } else {
      row(ctx, {
        check: 'Builder',
        status: 'warn',
        detail: `${det.builder}${det.version ? ` ${det.version}` : ''} detected, no builder abilities over MCP`,
        hint: det.builder === 'oxygen'
          ? 'Oxygen is installed but Agents & MCP is off — enable it under Oxygen → Settings → Agents & MCP.'
          : det.builder === 'elementor'
            ? 'Elementor layouts are edited through the Elementor connection (artivio-elementor-agent), not MCP.'
            : det.builder === 'divi'
              ? 'Divi layouts are edited through the DiviOps connection; enable it if the task needs layout changes.'
              : 'Layout editing for this builder needs a plugin that exposes it over MCP.',
      });
    }
    if (opts.writeProbe) {
      await writeProbe(ctx);
    }
  }

  ctx.discovered.capabilities = ctx.caps;
  const report: TestReport = {
    status: overallStatus(ctx.rows),
    rows: ctx.rows.map(r => ({ ...r, detail: redactSecrets(r.detail, [site.authSecret, site.ssh?.privateKey]) })),
    durationMs: Date.now() - started,
    testedAt: new Date().toISOString(),
  };
  return { discovered: ctx.discovered, report };
}

/** Load, test, persist. What the API route and the agent's wp_site_status call. */
export async function runSiteTest(tenantId: string, siteId: string, opts: TestOptions = {}): Promise<TestReport> {
  const site = await getResolvedSite(tenantId, siteId);
  if (!site) {
    throw new Error('Site not found.');
  }
  const { discovered, report } = await discoverAndTest(site, opts);
  await storeTestResult(tenantId, siteId, discovered, report);
  return report;
}

export function formatReport(label: string, report: TestReport): string {
  const icon = (s: TestRow['status']) => (s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : s === 'fail' ? '❌' : '⏭️');
  const lines = report.rows.map(r => `${icon(r.status)} ${r.check}: ${r.detail}${r.hint && r.status !== 'ok' ? ` → ${r.hint}` : ''}`);
  return [`Site "${label}" — ${report.status.toUpperCase()} (${report.durationMs}ms)`, ...lines].join('\n');
}
