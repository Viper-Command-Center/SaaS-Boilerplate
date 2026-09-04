/**
 * WP-CLI over SSH — built-in provider (per-connection, bring-your-own host).
 *
 * WP-CLI is a PHP program that runs ON the WordPress host with filesystem and
 * database access; it cannot be reached through the REST API. Every managed
 * WordPress host that matters (Hostinger, WP Engine, Kinsta, SiteGround,
 * Cloudways, Flywheel…) ships it preinstalled behind an SSH login, so the
 * portable way in is SSH — which is what this adapter does, with the pure-JS
 * `ssh2` client so the Railway image needs no `ssh` binary and no key on disk.
 *
 * Why not DiviOps' own `diviops_meta_wp_cli`: it only works with `WP_PATH`
 * (Local by Flywheel on the same machine) or `WP_CLI_CMD` (an executable
 * prefix — it would need an ssh binary + a key file + a second secret per
 * connection), and it only serves Divi sites. This provider is
 * builder-agnostic: Divi, Elementor and plain WordPress alike.
 *
 * Per-connection config (on the mcp_connection row, not the catalog):
 *   target     = user@host:port:/absolute/path/to/wordpress
 *                e.g. u195312244@45.13.134.129:65002:/home/u195312244/domains/site.com/public_html
 *   credential = the PEM private key. Generated SERVER-SIDE by
 *                POST /api/plugins/ssh-key (RSA-3072 — the format ssh2 parses
 *                natively; ed25519 PKCS#8 does not) and sealed straight into the
 *                vault; only the PUBLIC half is ever shown, for the client to
 *                paste into their host's "SSH keys" page. The private key never
 *                transits chat, a file, or a form.
 *
 * 🔴 ISOLATION IS THE PATH, NOT THE LOGIN. Shared-hosting SSH accounts are
 * account-wide (one Hostinger login reaches every site on the plan). So:
 *   · `--path` is PINNED from the connection target and any `--path`/`--url`/
 *     `--ssh`/`--http` in the agent's arguments is refused, so a workspace's
 *     tool cannot be steered at a sibling site;
 *   · arguments are passed as a shell-quoted argv — never interpolated into a
 *     command string — so nothing in them can open a second command;
 *   · a hard DENY list (eval, eval-file, shell, db drop/reset/clean/import/
 *     query/cli, site empty/delete, core download/install/update-db…) is
 *     enforced here regardless of tool policy, because the approvals gateway
 *     gates the TOOL, not the argument, and `wp eval` is a PHP shell.
 * Everything else rides the registry's per-tool policy (default: approval).
 *
 * Host keys: the first connection TRUSTS the host key it sees (no known_hosts
 * exists on the container). That is the same posture as `ssh` with
 * StrictHostKeyChecking=accept-new. Pinning the fingerprint on the connection
 * row is the obvious next hardening step when a client asks for it.
 */

import type { BuiltinProvider, BuiltinTool } from '@/libs/plugins/types';
import { Client as SshClient } from 'ssh2';

const CONNECT_TIMEOUT_MS = 20_000;
const EXEC_TIMEOUT_MS = 90_000;
const MAX_OUTPUT = 60_000;

// ─── Target ──────────────────────────────────────────────────────────────────

type Target = { user: string; host: string; port: number; path: string };

const TARGET_RE = /^([\w.+-]+)@([\w.-]+)(?::(\d{1,5}))?:(\/[^\s'"`$;&|<>]*)$/;

export function parseTarget(raw: string): Target {
  const m = TARGET_RE.exec((raw ?? '').trim());
  if (!m) {
    throw new Error(
      'WP-CLI: the target must be user@host:port:/absolute/path/to/wordpress — e.g. '
      + 'u123456789@45.13.134.129:65002:/home/u123456789/domains/example.com/public_html '
      + '(port is optional and defaults to 22). Get user/host/port from the host\'s SSH Access page; the path is the folder that contains wp-config.php.',
    );
  }
  const port = m[3] ? Number(m[3]) : 22;
  if (port < 1 || port > 65535) {
    throw new Error(`WP-CLI: port ${m[3]} is out of range.`);
  }
  return { user: m[1]!, host: m[2]!, port, path: m[4]!.replace(/\/+$/, '') || '/' };
}

// ─── Argument safety ─────────────────────────────────────────────────────────

/** Subcommand prefixes that are never run, whatever the tool policy says. */
export const WP_DENY_PREFIXES = [
  'eval', // arbitrary PHP
  'eval-file',
  'shell', // interactive PHP REPL
  'db drop',
  'db reset',
  'db clean',
  'db import', // replaces the whole database
  'db query', // arbitrary SQL — use the Postgres-style typed tools if ever needed
  'db cli',
  'site empty',
  'site delete',
  'core download',
  'core install',
  'core multisite-install',
  'core multisite-convert',
  'core update-db',
  'config create',
  'package', // installs code into wp-cli itself
  'cli update',
  'server', // starts a web server
];

/** Global flags that would move the call off the pinned site or run code. */
const DENIED_FLAG_RE = /^--(?:path|url|ssh|http|require|exec|skip-packages)(?:=|$)/;

function assertArgsSafe(args: string[]): void {
  if (args.length === 0) {
    throw new Error('WP-CLI: no command given.');
  }
  for (const a of args) {
    if (typeof a !== 'string') {
      throw new TypeError('WP-CLI: every argument must be a string.');
    }
    if (/[\r\n\0]/.test(a)) {
      throw new Error('WP-CLI: arguments may not contain newlines or NUL bytes.');
    }
    if (DENIED_FLAG_RE.test(a)) {
      throw new Error(
        `WP-CLI: the flag ${a.split('=')[0]} is not allowed — this connection is pinned to one site (its --path comes from the connection target) and cannot execute arbitrary code.`,
      );
    }
  }
  const words = args.filter(a => !a.startsWith('-'));
  const cmd2 = words.slice(0, 2).join(' ');
  const cmd1 = words[0] ?? '';
  const hit = WP_DENY_PREFIXES.find(p => p === cmd1 || p === cmd2 || cmd2.startsWith(`${p} `));
  if (hit) {
    throw new Error(
      `WP-CLI: "wp ${hit}" is refused on this platform (irreversible or arbitrary-code). This is a platform rule, not a permissions problem — do not look for a workaround; tell the human what you needed it for.`,
    );
  }
  if (cmd1 === 'search-replace' && !args.includes('--dry-run')) {
    throw new Error(
      'WP-CLI: a live search-replace through the generic tool is refused. Use wp_search_replace, which runs a dry run first and only goes live when dry_run is explicitly false.',
    );
  }
}

/** POSIX single-quote each argv element so nothing in it reaches the shell. */
function shellQuote(a: string): string {
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

// ─── SSH exec ────────────────────────────────────────────────────────────────

type ExecResult = { stdout: string; stderr: string; code: number | null };

function sshExec(target: Target, privateKey: string, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let settled = false;
    let killer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(killer);
        fn();
        conn.end();
      }
    };
    killer = setTimeout(() => finish(() => reject(new Error(`WP-CLI: command timed out after ${EXEC_TIMEOUT_MS / 1000}s.`))), EXEC_TIMEOUT_MS + CONNECT_TIMEOUT_MS);
    killer.unref();

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          finish(() => reject(new Error(`WP-CLI: could not start the command (${err.message}).`)));
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => {
          if (stdout.length < MAX_OUTPUT) {
            stdout += d.toString('utf8');
          }
        });
        stream.stderr.on('data', (d: Buffer) => {
          if (stderr.length < MAX_OUTPUT) {
            stderr += d.toString('utf8');
          }
        });
        stream.on('close', (code: number | null) => {
          finish(() => resolve({ stdout, stderr, code }));
        });
      });
    });
    conn.on('error', (err: Error & { level?: string }) => {
      const why = err.level === 'client-authentication'
        ? 'SSH authentication failed — the public key for this connection is probably not (yet) added on the host\'s SSH keys page, or SSH access is disabled there.'
        : err.level === 'client-timeout'
          ? 'SSH connection timed out — check the host and port on the connection target, and that SSH access is enabled on the hosting plan.'
          : `SSH error: ${err.message}`;
      finish(() => reject(new Error(`WP-CLI: ${why}`)));
    });
    conn.connect({
      host: target.host,
      port: target.port,
      username: target.user,
      privateKey,
      readyTimeout: CONNECT_TIMEOUT_MS,
      // See the header: accept-new posture. Pinning goes here when wanted.
      hostVerifier: () => true,
    });
  });
}

async function wp(target: Target, privateKey: string, args: string[]): Promise<ExecResult> {
  assertArgsSafe(args);
  const argv = ['wp', `--path=${target.path}`, '--no-color', ...args].map(shellQuote).join(' ');
  return sshExec(target, privateKey, argv);
}

function render(r: ExecResult, label: string): string {
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  if (r.code !== 0) {
    // wp-cli writes its own "Error: …" lines to stderr; keep them verbatim so
    // the model sees the real reason (missing plugin, unknown option…).
    throw new Error(`${label} failed (exit ${r.code ?? 'signal'}). ${err || out || 'no output'}`.slice(0, 4000));
  }
  const body = out || '(no output)';
  return err ? `${body}\n\n[stderr]\n${err}`.slice(0, MAX_OUTPUT) : body.slice(0, MAX_OUTPUT);
}

function asStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
    throw new Error(`WP-CLI: ${field} must be an array of strings.`);
  }
  return v as string[];
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const tools: BuiltinTool[] = [
  {
    name: 'wp_status',
    description: 'Connect over SSH and prove WP-CLI works on this site: WordPress core version, site URL, PHP version, and how many plugins have updates. Run this FIRST on a new connection — if it fails, nothing else will work and the error says whether it is the key (not added on the host yet), the host/port, or the path (no wp-config.php there).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'wp_cli',
    description: 'Run one WP-CLI command on the site. Pass the command as an argv ARRAY without the leading "wp" — e.g. ["option","get","blogname"], ["plugin","list","--status=active","--format=json"], ["post","list","--post_type=page","--fields=ID,post_title,post_status","--format=json"], ["transient","delete","--all"], ["rewrite","flush"], ["theme","list","--format=json"], ["user","list","--format=json"]. Prefer --format=json for anything you will reason about. The site path is pinned by the connection (do not pass --path/--url). Refused outright: eval, eval-file, shell, db drop/reset/clean/import/query, site empty/delete, core download/install, and a live search-replace (use wp_search_replace). Writes are approval-gated by policy.',
    input_schema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: 'argv after "wp", one element per token — flags included, e.g. ["option","get","siteurl"].' },
      },
      required: ['args'],
    },
  },
  {
    name: 'wp_cache_flush',
    description: 'Clear the object cache (wp cache flush), delete all transients, flush rewrite rules, and — when the LiteSpeed Cache plugin is present (Hostinger) — purge its page cache too. Use after content or option changes that are not showing on the live site. Reports each step.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'wp_option_get',
    description: 'Read one WordPress option (wp option get). Serialized/array options are returned as JSON. Common names: siteurl, home, blogname, blogdescription, admin_email, permalink_structure, active_plugins, template, stylesheet.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Option name.' } },
      required: ['name'],
    },
  },
  {
    name: 'wp_option_update',
    description: 'Set one WordPress option (wp option update). Pass value as a string; set format "json" to store an array/object from a JSON string. Changing siteurl/home moves the site — read both first and confirm with the human.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        value: { type: 'string' },
        format: { type: 'string', enum: ['plaintext', 'json'], description: 'Default plaintext.' },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'wp_search_replace',
    description: 'Search/replace across the database (wp search-replace) — the right tool for a domain change, an http→https migration, or a renamed asset path; it handles serialized data safely, unlike SQL. dry_run defaults to TRUE and reports what WOULD change per table. Only pass dry_run:false after the human has seen the dry-run counts. GUID column is skipped (WordPress rule).',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        replace: { type: 'string' },
        dry_run: { type: 'boolean', description: 'Default true.' },
        tables: { type: 'array', items: { type: 'string' }, description: 'Optional table list, e.g. ["wp_posts","wp_postmeta"]. Default: all tables with the site prefix.' },
        all_tables: { type: 'boolean', description: 'Include tables without the WordPress prefix (rarely needed).' },
      },
      required: ['search', 'replace'],
    },
  },
  {
    name: 'wp_plugin_list',
    description: 'List installed plugins with status, version and whether an update is available (wp plugin list --format=json).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'wp_plugin_update',
    description: 'Update one plugin by slug, or all plugins with all:true (wp plugin update). Updates come from wordpress.org or the plugin\'s licensed update server. Take a note of the versions from wp_plugin_list first so a regression can be attributed.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Plugin slug, e.g. "litespeed-cache".' },
        all: { type: 'boolean' },
      },
    },
  },
];

// ─── Provider ────────────────────────────────────────────────────────────────

export const wpcliProvider: BuiltinProvider = {
  slug: 'wpcli',
  name: 'WP-CLI over SSH (any WordPress host)',
  description:
    'Run WP-CLI on a WordPress site over SSH — cache flush, options, plugin updates, safe search-replace, and any allowlisted wp command. Works on every host with SSH + WP-CLI (Hostinger, WP Engine, Kinsta, SiteGround, Cloudways…) and every builder.',
  perConnection: true,
  credentialLabel:
    'The SSH private key (PEM). Use "Generate SSH key" in the Tools panel — the key is created on the platform and sealed in the vault; you only ever see the PUBLIC key to paste into your host\'s SSH keys page.',
  targetLabel: 'SSH target — user@host:port:/path/to/wordpress',
  targetPlaceholder: 'u123456789@45.13.134.129:65002:/home/u123456789/domains/example.com/public_html',
  targetIsUrl: false,
  credentialKind: 'ssh-key',

  guidance: [
    'WP-CLI over SSH runs ON the live server as the hosting account. There is no draft mode. Reads (wp_status, wp_option_get, wp_plugin_list, wp_cli with get/list) are safe; anything else changes the live site the moment it runs.',
    'Start every new connection with wp_status. Its error tells you which of key / host+port / path is wrong — do not guess at fixes; relay it.',
    'For a domain or protocol change use wp_search_replace with the dry run first, show the human the per-table counts, and only then run it live. Never do this with raw SQL.',
    'After changing options, plugins or content that does not show on the live site, run wp_cache_flush — Hostinger sites sit behind LiteSpeed and CDN caches.',
    'On shared hosting the SSH login is account-wide, but THIS connection is pinned to one site path and refuses --path/--url. If a task needs a different site, it needs its own connection; do not try to reach it from here.',
    'eval, eval-file, shell, db drop/reset/import/query and core install are refused by the platform. That is a rule, not a bug; say what you needed and stop.',
  ].join('\n'),

  tools,

  call: async (tool, args, credential, target): Promise<string> => {
    const key = (credential ?? '').trim();
    if (!key.includes('PRIVATE KEY')) {
      throw new Error('WP-CLI: this connection has no SSH private key — remove it and enable the plugin again using "Generate SSH key".');
    }
    const t = parseTarget(target ?? '');

    switch (tool) {
      case 'wp_status': {
        const version = render(await wp(t, key, ['core', 'version']), 'wp core version');
        const siteurl = render(await wp(t, key, ['option', 'get', 'siteurl']), 'wp option get siteurl');
        // `wp cli info` reports the PHP binary + version and the WP-CLI version.
        const info = render(await wp(t, key, ['cli', 'info']), 'wp cli info');
        const plugins = render(await wp(t, key, ['plugin', 'list', '--update=available', '--format=count']), 'wp plugin list');
        return [
          `WordPress ${version} at ${siteurl}`,
          `Path: ${t.path} (${t.user}@${t.host}:${t.port})`,
          `Plugins with updates available: ${plugins}`,
          '',
          info,
        ].join('\n');
      }
      case 'wp_cli': {
        const argv = asStringArray(args.args, 'args');
        return render(await wp(t, key, argv), `wp ${argv.slice(0, 2).join(' ')}`);
      }
      case 'wp_cache_flush': {
        const steps: string[] = [];
        const run = async (label: string, argv: string[], optional = false) => {
          try {
            steps.push(`${label}: ${render(await wp(t, key, argv), label).split('\n')[0]}`);
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
      case 'wp_option_get': {
        const name = String(args.name ?? '').trim();
        if (!name) {
          throw new Error('WP-CLI: name is required.');
        }
        return render(await wp(t, key, ['option', 'get', name, '--format=json']), `wp option get ${name}`);
      }
      case 'wp_option_update': {
        const name = String(args.name ?? '').trim();
        const value = String(args.value ?? '');
        if (!name) {
          throw new Error('WP-CLI: name is required.');
        }
        const argv = ['option', 'update', name, value];
        if (args.format === 'json') {
          argv.push('--format=json');
        }
        return render(await wp(t, key, argv), `wp option update ${name}`);
      }
      case 'wp_search_replace': {
        const search = String(args.search ?? '');
        const replace = String(args.replace ?? '');
        if (!search) {
          throw new Error('WP-CLI: search is required.');
        }
        const dryRun = args.dry_run !== false;
        const argv = ['search-replace', search, replace];
        if (Array.isArray(args.tables) && args.tables.length > 0) {
          argv.push(...asStringArray(args.tables, 'tables'));
        }
        argv.push('--skip-columns=guid', '--report-changed-only');
        if (args.all_tables === true) {
          argv.push('--all-tables');
        }
        if (dryRun) {
          argv.push('--dry-run');
        }
        // The generic gate refuses a live search-replace; this typed path is
        // the one deliberate exception, so bypass assertArgsSafe's rule by
        // calling sshExec through wp() with --dry-run present, or directly when live.
        const result = dryRun
          ? await wp(t, key, argv)
          : await sshExec(t, key, ['wp', `--path=${t.path}`, '--no-color', ...argv].map(shellQuote).join(' '));
        const body = render(result, dryRun ? 'wp search-replace (dry run)' : 'wp search-replace (LIVE)');
        return dryRun
          ? `DRY RUN — nothing changed. Per-table counts of what WOULD change:\n${body}\n\nTo apply, call wp_search_replace again with dry_run:false after the human has seen these counts.`
          : `LIVE search-replace applied:\n${body}\n\nRun wp_cache_flush so the change is visible.`;
      }
      case 'wp_plugin_list':
        return render(await wp(t, key, ['plugin', 'list', '--format=json']), 'wp plugin list');
      case 'wp_plugin_update': {
        const name = String(args.name ?? '').trim();
        if (args.all === true) {
          return render(await wp(t, key, ['plugin', 'update', '--all']), 'wp plugin update --all');
        }
        if (!name) {
          throw new Error('WP-CLI: give a plugin slug in name, or all:true.');
        }
        return render(await wp(t, key, ['plugin', 'update', name]), `wp plugin update ${name}`);
      }
      default:
        throw new Error(`WP-CLI: unknown tool ${tool}`);
    }
  },
};
