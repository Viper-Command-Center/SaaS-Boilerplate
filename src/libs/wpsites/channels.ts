/**
 * The three channels a WordPress site is reached through. Each function takes
 * a ResolvedSite (secrets open) and never lets a secret out: every thrown
 * error and every returned string goes through redactSecrets.
 */

import type { ExecResult } from '@/libs/plugins/wpcli';
import type { ResolvedSite } from '@/libs/wpsites/types';
import { McpHttpClient } from '@/libs/mcp/client';
import { assertArgsSafe, shellQuote, sshExec, sshUpload } from '@/libs/plugins/wpcli';
import { buildAuthHeader } from '@/libs/wpsites/auth';
import { redactError, redactSecrets } from '@/libs/wpsites/redact';

export const REST_TIMEOUT_MS = 30_000;
export const MAX_REST_BODY = 200_000;
/** Largest body we will JSON-parse in full (REST indexes with many plugins run to ~500 KB). */
export const MAX_PARSE_BODY = 8_000_000;
export const MAX_OUTPUT = 60_000;

export function siteSecrets(site: ResolvedSite): string[] {
  return [site.authSecret, site.ssh?.privateKey ?? ''];
}

// ─── REST ────────────────────────────────────────────────────────────────────

export type RestResponse = {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Parsed JSON when the body was JSON, else the text. Capped. */
  body: unknown;
  text: string;
};

/**
 * One REST request against the site. `route` is relative to /wp-json — e.g.
 * "/wp/v2/posts?per_page=5" or "/artivio/v1/site" — or an absolute URL on the
 * same origin. Anything else is refused: a site credential must only ever be
 * sent to that site.
 */
export async function restRequest(
  site: ResolvedSite,
  method: string,
  route: string,
  body?: unknown,
  init?: { headers?: Record<string, string>; raw?: BodyInit; timeoutMs?: number },
): Promise<RestResponse> {
  const url = resolveRoute(site.siteUrl, route);
  const headers: Record<string, string> = {
    Authorization: buildAuthHeader(site.authScheme, site.authUser, site.authSecret),
    Accept: 'application/json',
    ...(init?.headers ?? {}),
  };
  let payload: BodyInit | undefined;
  if (init?.raw !== undefined) {
    payload = init.raw;
  } else if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(init?.timeoutMs ?? REST_TIMEOUT_MS),
    });
  } catch (err) {
    throw redactError(new Error(`WordPress (${site.label}): could not reach ${site.siteUrl} — ${err instanceof Error ? err.message : 'network error'}`), siteSecrets(site));
  }
  // Parse the WHOLE body, then cap what we keep as text. Truncating first
  // broke JSON that was simply large — a site's /wp-json/ index with a page
  // builder and a dozen plugins is 300–500 KB — and Reachability then
  // reported "HTTP 200" and "failed" in the same row (build.churchwebglobal.com,
  // 2026-09-06). MAX_REST_BODY still bounds what reaches the agent/logs.
  const full = redactSecrets((await resp.text()).slice(0, MAX_PARSE_BODY), siteSecrets(site));
  const text = full.slice(0, MAX_REST_BODY);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(full);
  } catch { /* not JSON (or over MAX_PARSE_BODY) — text stays */ }
  const outHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    outHeaders[k.toLowerCase()] = v;
  });
  return { status: resp.status, ok: resp.ok, headers: outHeaders, body: parsed, text };
}

export function resolveRoute(siteUrl: string, route: string): string {
  const base = new URL(siteUrl);
  let target: URL;
  if (/^https?:\/\//i.test(route)) {
    target = new URL(route);
    if (target.host.toLowerCase() !== base.host.toLowerCase()) {
      throw new Error(`WordPress Sites: refusing to send this site's credential to ${target.host} — routes must be on ${base.host}.`);
    }
    return target.toString();
  }
  const rel = route.startsWith('/') ? route : `/${route}`;
  const prefixed = rel.startsWith('/wp-json') ? rel : `/wp-json${rel}`;
  return `${siteUrl}${prefixed}`;
}

/** Turn a non-2xx REST response into the error the agent should read. */
export function explainRestFailure(site: ResolvedSite, r: RestResponse, route: string): string {
  const j = (typeof r.body === 'object' && r.body) ? r.body as { code?: string; message?: string } : {};
  let msg = `HTTP ${r.status}${j.code ? ` ${j.code}` : ''}${j.message ? ` — ${j.message}` : ''}`;
  if (r.status === 401 || r.status === 403) {
    msg += ` — check the username and application password for site "${site.label}" (Tools → WordPress Sites → Test), and that the agent user is an Administrator.`;
  }
  if (j.code === 'rest_no_route' && route.includes('/artivio/')) {
    msg += ' — the artivio-wp-agent base plugin is not installed or not active on this site (one-time upload via wp-admin → Plugins → Add New).';
  }
  if (j.code === 'rest_post_invalid_id' || /invalid post id/i.test(j.message ?? '')) {
    msg += ' — posts and pages are SEPARATE collections in WordPress; pass the matching type.';
  }
  return `WordPress (${site.label}): ${msg}`;
}

// ─── MCP ─────────────────────────────────────────────────────────────────────

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown };
};

export function mcpClientFor(site: ResolvedSite): McpHttpClient {
  if (!site.mcpEndpointUrl) {
    throw new Error(`WordPress (${site.label}): no MCP endpoint was discovered on this site. Run Test in Tools → WordPress Sites; if it stays ❌, install Oxygen's Agent Connector (Oxygen → Settings → Agents & MCP) or the WordPress MCP Adapter plugin.`);
  }
  return new McpHttpClient(site.mcpEndpointUrl, {
    Authorization: buildAuthHeader(site.authScheme, site.authUser, site.authSecret),
  });
}

export async function mcpListTools(site: ResolvedSite): Promise<McpToolInfo[]> {
  try {
    const tools = await mcpClientFor(site).listTools();
    return tools as McpToolInfo[];
  } catch (err) {
    throw redactError(err, siteSecrets(site));
  }
}

export async function mcpCall(site: ResolvedSite, tool: string, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await mcpClientFor(site).callTool(tool, args);
    const text = result.content.map((b) => {
      if (typeof b.text === 'string') {
        return b.text;
      }
      const res = (b as { resource?: { text?: string } }).resource;
      if (res?.text) {
        return res.text;
      }
      return `[${b.type}]`;
    }).join('\n');
    const out = redactSecrets(text.slice(0, MAX_OUTPUT), siteSecrets(site));
    if (result.isError) {
      throw new Error(`WordPress MCP (${site.label}) ${tool}: ${out}`);
    }
    return out;
  } catch (err) {
    const clean = redactError(err, siteSecrets(site));
    // A guessed ability name ("html-to-page", "oxygen-post-tree") comes back
    // as a bare JSON-RPC 404. Seen 2026-09-07: the agent burned four turns
    // guessing before calling wp_mcp_tools. Name the closest real abilities.
    if (/Tool not found/i.test(clean.message)) {
      const hint = await suggestMcpNames(site, tool).catch(() => '');
      throw new Error(`WordPress MCP (${site.label}): no ability named "${tool}" on this site.${hint} Names are exact — read them from wp_mcp_tools.`);
    }
    throw clean;
  }
}

async function suggestMcpNames(site: ResolvedSite, wanted: string): Promise<string> {
  const names = (await mcpListTools(site)).map(t => t.name);
  const tokens = wanted.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2 && t !== 'oxygen');
  const scored = names
    .map(n => ({ n, score: tokens.filter(t => n.toLowerCase().includes(t)).length }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(x => x.n);
  return scored.length ? ` Closest: ${scored.join(', ')}.` : ` It exposes ${names.length} abilities.`;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export function requireSsh(site: ResolvedSite) {
  if (!site.ssh) {
    throw new Error(`WordPress (${site.label}): WP-CLI over SSH is not enabled on this site. The owner adds host/user/path and a workspace SSH key in Tools → WordPress Sites → Edit.`);
  }
  return site.ssh;
}

/** Run one guarded WP-CLI command on the site (path pinned, deny list on). */
export async function cliExec(site: ResolvedSite, args: string[]): Promise<ExecResult> {
  const ssh = requireSsh(site);
  assertArgsSafe(args);
  const argv = ['wp', `--path=${ssh.path}`, '--no-color', ...args].map(shellQuote).join(' ');
  return cliRaw(site, argv);
}

/** Push bytes to a path on the host over SFTP (redacted errors). */
export async function cliUpload(site: ResolvedSite, remotePath: string, bytes: Buffer): Promise<void> {
  const ssh = requireSsh(site);
  try {
    await sshUpload({ host: ssh.host, port: ssh.port, user: ssh.user, path: ssh.path }, ssh.privateKey, remotePath, bytes);
  } catch (err) {
    throw redactError(err, siteSecrets(site));
  }
}

/** The one caller that deliberately skips assertArgsSafe (typed live search-replace). */
export async function cliRaw(site: ResolvedSite, command: string): Promise<ExecResult> {
  const ssh = requireSsh(site);
  try {
    const r = await sshExec({ host: ssh.host, port: ssh.port, user: ssh.user, path: ssh.path }, ssh.privateKey, command);
    return {
      stdout: redactSecrets(r.stdout, siteSecrets(site)),
      stderr: redactSecrets(r.stderr, siteSecrets(site)),
      code: r.code,
    };
  } catch (err) {
    throw redactError(err, siteSecrets(site));
  }
}

export function renderCli(r: ExecResult, label: string): string {
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  if (r.code !== 0) {
    throw new Error(`${label} failed (exit ${r.code ?? 'signal'}). ${err || out || 'no output'}`.slice(0, 4000));
  }
  const body = out || '(no output)';
  return err ? `${body}\n\n[stderr]\n${err}`.slice(0, MAX_OUTPUT) : body.slice(0, MAX_OUTPUT);
}
