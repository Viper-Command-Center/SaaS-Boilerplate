/**
 * SmarterMail — built-in provider (per-server, bring-your-own credential).
 *
 * SmarterMail publishes no MCP server. Its REST API lives under /api/v1 and is
 * a normal JSON API, but three things about it shape this adapter:
 *
 * 1. THERE ARE NO API KEYS. You authenticate as a real mail account —
 *    POST /api/v1/auth/authenticate-user with a username and password — and
 *    get back a short-lived bearer token. So the vaulted credential is a
 *    genuine SmarterMail login, which is why the setup guidance insists on a
 *    dedicated system-admin account rather than reusing a human's: it can be
 *    revoked on its own, and its actions are distinguishable in SmarterMail's
 *    own logs.
 *
 * 2. THE TOKEN EXPIRES, typically within the hour. Authenticating on every
 *    call would work but wastes a round trip on each one and writes a login
 *    record every time; so tokens are cached in-process, keyed by server and
 *    account, and refreshed before they lapse.
 *
 * 3. THE ENDPOINT SURFACE MOVES BETWEEN BUILDS. SmarterMail's API reference is
 *    served by each installation at <server>/Documentation/api rather than
 *    published centrally, and paths have changed across major versions. A
 *    fixed tool list would therefore rot silently on upgrade. The curated
 *    tools below cover the paths that have been stable, and `smartermail_call`
 *    reaches everything else — including anything a future build adds — with
 *    the server's own documentation as the reference.
 *
 * Per-connection config (stored on the mcp_connection, not the catalog):
 *   url        = the SmarterMail server, e.g. https://mail.churchwebglobal.com
 *   credential = "username:password" for the API account
 */

import type { BuiltinProvider } from '@/libs/plugins/types';

const MAX_OUTPUT = 120_000;

/**
 * Cached bearer tokens, keyed by "<server>|<username>".
 *
 * Deliberately module-level and in-process: it is a cache, not state. A cold
 * lambda simply authenticates again, and there is nothing here worth the
 * complexity (or the vault round trip) of persisting. Values are tokens, never
 * the password.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Re-authenticate this long before the token actually lapses. */
const EXPIRY_MARGIN_MS = 60_000;

export function parseCredential(raw: string): { username: string; password: string } {
  /**
   * Strip surrounding NEWLINES only — not spaces.
   *
   * A credential pasted into the Tools panel routinely carries a trailing
   * newline, so that has to go. A trailing SPACE is different: it is a legal
   * password character, and trimming it turns a correct credential into a
   * permanent "the username or password was rejected", which sends someone to
   * re-check a password that was right all along. The username is trimmed
   * separately below, where spaces are never meaningful.
   */
  const value = (raw ?? '').replace(/^[\r\n]+|[\r\n]+$/g, '');
  const at = value.indexOf(':');
  if (at < 1) {
    throw new Error(
      'SmarterMail: the credential must be "username:password" — the login of the account Artivio '
      + 'authenticates as (use a dedicated system administrator account, e.g. artivio@yourdomain.com). '
      + 'SmarterMail does not issue API keys.',
    );
  }
  const username = value.slice(0, at).trim();
  // The password is everything after the FIRST colon, so it may contain colons.
  const password = value.slice(at + 1);
  if (!username || !password) {
    throw new Error('SmarterMail: the credential is missing the username or the password.');
  }
  return { username, password };
}

/** Normalise a server URL and a path into one absolute URL. */
export function buildUrl(server: string | undefined, path: string): string {
  if (!server) {
    throw new Error('SmarterMail: this connection has no server URL set. Add it in the Tools panel.');
  }
  const base = server.replace(/\/+$/, '');
  let clean = String(path ?? '').trim();
  if (!clean) {
    throw new Error('SmarterMail rejected the request: no API path was given.');
  }
  // Accept "settings/domain/data", "/settings/domain/data" and the full
  // "/api/v1/settings/domain/data" — all three are things a caller reasonably
  // supplies, and guessing wrong costs a 404 that reads like a missing feature.
  clean = clean.replace(/^\/+/, '');
  if (!/^api\/v\d+\//i.test(clean)) {
    clean = `api/v1/${clean}`;
  }
  return `${base}/${clean}`;
}

/**
 * Paths that change or destroy accounts and data.
 *
 * As with WHMCS, `confirm_destructive` is NOT a security control — the agent
 * can set it. What it buys is that the destruction is an explicit argument in
 * the approval request a human reads, rather than a verb buried in a URL.
 */
const DESTRUCTIVE_PATTERNS = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bdisable\b/i,
  /\bwipe\b/i,
  /\bpurge\b/i,
  /\bclear-?spool\b/i,
];

/**
 * Blocked outright, no override.
 *
 * Impersonation mints a token that acts AS a mailbox owner — it reads their
 * mail. There is a real administrative use for it in SmarterMail's own UI, but
 * an agent holding one would put a church member's private correspondence into
 * a transcript, and no troubleshooting task here needs that. Mailbox contents
 * are diagnosed through delivery logs and spool metadata, not by reading mail.
 */
const FORBIDDEN_PATTERNS = [/impersonate/i];

export function guardPath(method: string, path: string, confirmed: boolean): void {
  const target = `${method} ${path}`;

  if (FORBIDDEN_PATTERNS.some(re => re.test(path))) {
    throw new Error(
      `SmarterMail: "${path}" is blocked by Artivio and cannot be enabled. It signs in as a mailbox `
      + 'owner and can read their mail, which would then live in the conversation transcript. '
      + 'Diagnose delivery through the logs and spool instead.',
    );
  }

  // A GET is a read. Only state-changing verbs can be destructive.
  const writes = !/^get$/i.test(method.trim());
  if (writes && !confirmed && DESTRUCTIVE_PATTERNS.some(re => re.test(path))) {
    throw new Error(
      `SmarterMail: "${target}" looks like it removes or disables something, so it is blocked by default. `
      + 'If that is genuinely intended, call it again with confirm_destructive: true — and say in your '
      + 'message to the human exactly what will be removed, because that is what they are approving.',
    );
  }
}

/** Authenticate and cache the bearer token. */
async function tokenFor(server: string, credential: string): Promise<string> {
  const { username, password } = parseCredential(credential);
  const key = `${server}|${username}`;

  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + EXPIRY_MARGIN_MS) {
    return cached.token;
  }

  const url = buildUrl(server, 'auth/authenticate-user');
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch (e) {
    throw new Error(`SmarterMail: could not reach ${url} — ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(
      `SmarterMail: HTTP ${resp.status} authenticating as ${username}`
      + `${resp.status === 401 ? ' — the username or password was rejected.' : ''}`
      + `${text ? ` — ${text.slice(0, 200)}` : ''}`,
    );
  }

  let body: Record<string, any>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `SmarterMail: ${url} did not return JSON. The connection URL should be the mail server's base address, `
      + `e.g. https://mail.example.com. Received: ${text.slice(0, 200)}`,
    );
  }

  /**
   * 🔴 SmarterMail answers a BAD PASSWORD with 200 OK and success:false.
   * Without this branch a wrong credential surfaces as "token is undefined"
   * from the next call — an error that points at our code rather than at the
   * password, which is exactly the kind of misdirection that costs an evening.
   */
  const token = body.accessToken;
  if (!token) {
    const message = String(body.message ?? body.Message ?? '(no message)');
    throw new Error(
      `SmarterMail rejected the sign-in for ${username}: ${message} — check the username and password, `
      + 'and that the account is enabled and permitted to use the API.',
    );
  }

  // accessTokenExpiration is an ISO timestamp on current builds. If it is
  // missing or unparseable, fall back to a conservative 20 minutes rather than
  // trusting a token indefinitely — a stale token fails mid-task, and the
  // caller cannot tell that from a permissions problem.
  const parsed = Date.parse(String(body.accessTokenExpiration ?? ''));
  const expiresAt = Number.isFinite(parsed) && parsed > Date.now()
    ? parsed
    : Date.now() + 20 * 60_000;

  tokenCache.set(key, { token, expiresAt });
  return token;
}

/** One authenticated API call. */
async function api(
  server: string | undefined,
  credential: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Record<string, any>> {
  if (!server) {
    throw new Error('SmarterMail: this connection has no server URL set. Add it in the Tools panel.');
  }
  const base = server.replace(/\/+$/, '');
  const method = (init?.method ?? (init?.body === undefined ? 'GET' : 'POST')).toUpperCase();
  const url = buildUrl(base, path);

  const send = async (token: string) => fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  let resp: Response;
  try {
    resp = await send(await tokenFor(base, credential));

    /**
     * A cached token can lapse between the expiry check and the request — or
     * be invalidated server-side by a restart or a password change. Drop it
     * and authenticate once more. Exactly ONE retry: if a fresh token is also
     * rejected, the problem is permissions, and retrying a permissions failure
     * in a loop is how an account gets locked out.
     */
    if (resp.status === 401) {
      const { username } = parseCredential(credential);
      tokenCache.delete(`${base}|${username}`);
      resp = await send(await tokenFor(base, credential));
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('SmarterMail')) {
      throw e;
    }
    throw new Error(`SmarterMail: could not reach ${url} — ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await resp.text();

  if (!resp.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = String(j.message ?? j.Message ?? detail);
    } catch { /* not JSON — the status carries the meaning */ }

    let hint = '';
    if (resp.status === 401 || resp.status === 403) {
      hint = ' — the API account is authenticated but not permitted to do this. System-administrator '
        + 'endpoints (domains, spool, blocked IPs) need a system admin account; a domain admin cannot reach them.';
    } else if (resp.status === 404) {
      hint = ` — this SmarterMail build may not expose "${path}". Endpoint paths differ between major `
        + `versions; the authoritative list for THIS server is at ${base}/Documentation/api.`;
    }

    throw new Error(`SmarterMail: HTTP ${resp.status} on ${method} ${path} — ${detail}${hint}`);
  }

  let body: Record<string, any>;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`SmarterMail: ${method} ${path} returned a non-JSON body — ${text.slice(0, 200)}`);
  }

  /**
   * 🔴 200 OK IS NOT SUCCESS. SmarterMail reports failures in the body with
   * success:false, so a caller that trusts the status reports a change that
   * never happened. "rejected the request" is phrasing classifyToolError()
   * recognises as client-fixable, so a bad domain name is not emailed to the
   * operator as an Artivio bug.
   */
  if (body.success === false) {
    const message = String(body.message ?? body.Message ?? '(no message)');
    throw new Error(`SmarterMail rejected the request (${method} ${path}): ${message}`);
  }

  return body;
}

function cap(value: unknown): string {
  const json = JSON.stringify(value);
  return json.length <= MAX_OUTPUT
    ? json
    : `${json.slice(0, MAX_OUTPUT)}\n…truncated. Narrow the query — fewer rows, a shorter date range, or one domain at a time.`;
}

export const smartermailProvider: BuiltinProvider = {
  slug: 'smartermail',
  name: 'SmarterMail',
  description:
    'Manage and troubleshoot email on a SmarterMail server — domains and DKIM/SPF, mailboxes and aliases, delivery failures and the spool, spam scores and blocked IPs. Any other API path is reachable through smartermail_call.',
  credentialLabel:
    'SmarterMail login as "username:password" — use a dedicated system administrator account created for Artivio (SmarterMail issues no API keys, so this is a real account)',
  perConnection: true,
  targetLabel: 'SmarterMail server URL',
  targetPlaceholder: 'https://mail.example.com',

  guidance: `SmarterMail connection:
- SmarterMail answers HTTP 200 to some failures, flagging them as success:false in the body. The tools here already throw on that; if you use smartermail_call, do not read a 200 as "it worked" — check the body.
- Endpoint paths differ between SmarterMail major versions, and this server documents its own at <server>/Documentation/api. If a tool 404s, that is the place to look up the current path and then use smartermail_call — it is not a sign the feature is missing.
- Diagnose delivery in this order: check the spool first (is it stuck here?), then the delivery log for that recipient (did we try, and what did the far end say?), then blocked IPs and spam scores (are we or they being refused?). Jumping straight to spam settings is the usual wrong turn — most "not arriving" reports are a full mailbox or a bounce nobody read.
- A bounce reason from the receiving server is the most valuable line in any of this. Quote it verbatim to the human rather than paraphrasing; "550 5.7.1 SPF check failed" tells them what to fix, "the message was rejected" does not.
- Mailbox contents are off limits. Nothing here reads a user's mail, and impersonation is blocked outright — troubleshoot from logs and spool metadata.
- Changing a password disconnects that person's mail client until they update it. Say so when proposing one, and never reset a password that was not asked about.
- This server hosts many churches. Always state which domain you acted on; a fix applied to the wrong domain looks identical to a fix that worked.`,

  tools: [
    // ── Domains ────────────────────────────────────────────────────────────
    {
      name: 'list_domains',
      description: 'Every domain on the server, with user counts and status. System admin only.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'get_domain',
      description: 'Settings for one domain — limits, features, and the DKIM/SPF configuration that decides whether its mail is trusted.',
      input_schema: {
        type: 'object',
        properties: { domain: { type: 'string', description: 'e.g. examplechurch.org' } },
        required: ['domain'],
      },
    },
    {
      name: 'domain_users',
      description: 'Mailboxes on a domain, with status and quota usage. Start here for "their email is not working".',
      input_schema: {
        type: 'object',
        properties: { domain: { type: 'string' } },
        required: ['domain'],
      },
    },

    // ── Mailboxes ──────────────────────────────────────────────────────────
    {
      name: 'get_user',
      description: 'One mailbox in detail — status, quota and usage, forwarding, last login. The first thing to check when someone reports missing mail: a full mailbox rejects deliveries and looks exactly like a delivery fault.',
      input_schema: {
        type: 'object',
        properties: { email: { type: 'string' } },
        required: ['email'],
      },
    },
    {
      name: 'create_user',
      description: 'Create a mailbox on a domain.',
      input_schema: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          password: { type: 'string' },
          display_name: { type: 'string' },
          quota_mb: { type: 'number', description: 'Mailbox size limit in MB; omit for the domain default' },
        },
        required: ['email', 'password'],
      },
    },
    {
      name: 'set_user_password',
      description: 'Set a mailbox password. This disconnects that person\'s mail clients until they enter the new one — only do it when someone asked, and tell them it will happen.',
      input_schema: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          password: { type: 'string' },
        },
        required: ['email', 'password'],
      },
    },
    {
      name: 'list_aliases',
      description: 'Aliases and forwards on a domain — where mail to an address actually ends up. A forward pointing somewhere stale is a common cause of "we stopped getting enquiries".',
      input_schema: {
        type: 'object',
        properties: { domain: { type: 'string' } },
        required: ['domain'],
      },
    },

    // ── Delivery ───────────────────────────────────────────────────────────
    {
      name: 'get_spool',
      description: 'Messages currently queued for delivery, with age and retry count. A growing spool means the server is trying and failing to hand mail off; an empty spool means the problem is upstream or already ended in a bounce.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max rows (default 50)' },
        },
      },
    },
    {
      name: 'search_delivery_log',
      description: 'Search the delivery log for what happened to mail to or from an address, including the receiving server\'s own refusal text. This is where a real answer usually is — quote the remote response verbatim.',
      input_schema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Email address, domain, or message id' },
          date: { type: 'string', description: 'YYYY-MM-DD (defaults to today)' },
          limit: { type: 'number' },
        },
        required: ['search'],
      },
    },
    {
      name: 'traffic_stats',
      description: 'Message traffic volumes for the server — sent, received, and how much was rejected as spam. Use it to tell "this one user" apart from "the whole server".',
      input_schema: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'YYYY-MM-DD' },
          end_date: { type: 'string', description: 'YYYY-MM-DD' },
        },
      },
    },

    // ── Spam and blocks ────────────────────────────────────────────────────
    {
      name: 'list_blocked_ips',
      description: 'IP addresses SmarterMail\'s intrusion detection is currently blocking. A church office whose whole staff "cannot send" is very often one blocked office IP after a wrong password.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'unblock_ip',
      description: 'Remove an IP from the intrusion-detection block list. Confirm who the address belongs to before clearing it.',
      input_schema: {
        type: 'object',
        properties: {
          ip: { type: 'string' },
          type: { type: 'string', description: 'Which block list: smtp | imap | pop | webmail | xmpp (default all)' },
        },
        required: ['ip'],
      },
    },
    {
      name: 'get_spam_settings',
      description: 'Server or domain spam-filtering configuration — thresholds, RBLs in use, and what each score does.',
      input_schema: {
        type: 'object',
        properties: { domain: { type: 'string', description: 'Omit for the server-wide settings' } },
      },
    },

    // ── Escape hatch ───────────────────────────────────────────────────────
    {
      name: 'smartermail_call',
      description:
        'Call any SmarterMail API path directly, for anything the tools above do not cover or that this build names differently. THIS SERVER documents its own API at <server>/Documentation/api — use that rather than guessing. Paths may be given with or without the /api/v1 prefix.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'e.g. settings/sysadmin/domains or /api/v1/settings/domain/data' },
          method: { type: 'string', description: 'GET | POST | PUT | DELETE (default GET, or POST when a body is given)' },
          body: { type: 'object', description: 'JSON body for a write' },
          confirm_destructive: {
            type: 'boolean',
            description: 'Required for paths that delete, remove, disable or purge. Setting it means a human has been told exactly what will be affected.',
          },
        },
        required: ['path'],
      },
    },
  ],

  call: async (tool, args, credential, server) => {
    const get = (path: string) => api(server, credential, path);
    const post = (path: string, body: unknown) => api(server, credential, path, { method: 'POST', body });

    switch (tool) {
      // ── Domains ──
      case 'list_domains':
        return cap(await get('settings/sysadmin/domains'));

      case 'get_domain':
        return cap(await get(`settings/sysadmin/domain/${encodeURIComponent(String(args.domain))}`));

      case 'domain_users':
        return cap(await get(`settings/sysadmin/domain-users/${encodeURIComponent(String(args.domain))}`));

      // ── Mailboxes ──
      case 'get_user':
        return cap(await post('settings/sysadmin/get-user', { email: args.email }));

      case 'create_user':
        return cap(await post('settings/sysadmin/user-put', {
          userData: {
            userName: args.email,
            password: args.password,
            displayName: args.display_name ?? args.email,
            ...(args.quota_mb === undefined ? {} : { maxMailboxSize: Number(args.quota_mb) }),
          },
        }));

      case 'set_user_password':
        return cap(await post('settings/sysadmin/user-password-put', {
          email: args.email,
          password: args.password,
        }));

      case 'list_aliases':
        return cap(await get(`settings/domain/alias/${encodeURIComponent(String(args.domain))}`));

      // ── Delivery ──
      case 'get_spool':
        return cap(await post('settings/sysadmin/spool-messages', {
          take: Math.min(Number(args.limit) || 50, 200),
          skip: 0,
        }));

      case 'search_delivery_log':
        return cap(await post('settings/sysadmin/search-delivery-logs', {
          search: args.search,
          date: args.date,
          take: Math.min(Number(args.limit) || 50, 200),
        }));

      case 'traffic_stats':
        return cap(await post('settings/sysadmin/message-traffic-statistics', {
          startDate: args.start_date,
          endDate: args.end_date,
        }));

      // ── Spam and blocks ──
      case 'list_blocked_ips':
        return cap(await get('settings/sysadmin/ids-blocks'));

      case 'unblock_ip':
        return cap(await post('settings/sysadmin/ids-block-delete', {
          ip: args.ip,
          ...(args.type ? { type: args.type } : {}),
        }));

      case 'get_spam_settings':
        return cap(args.domain
          ? await get(`settings/domain/spam-settings/${encodeURIComponent(String(args.domain))}`)
          : await get('settings/sysadmin/antispam-settings'));

      // ── Escape hatch ──
      case 'smartermail_call': {
        const path = String(args.path ?? '');
        const method = String(args.method ?? (args.body === undefined ? 'GET' : 'POST')).toUpperCase();
        guardPath(method, path, args.confirm_destructive === true);
        return cap(await api(server, credential, path, {
          method,
          body: args.body,
        }));
      }

      default:
        throw new Error(`Unknown SmarterMail tool: ${tool}`);
    }
  },
};

/** Test seam: the token cache is process-global and would leak between tests. */
export function __clearTokenCache(): void {
  tokenCache.clear();
}
