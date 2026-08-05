/**
 * Google Analytics 4 + Search Console — built-in provider (per-connection, BYO
 * service account).
 *
 * 🔑 WHY A SERVICE ACCOUNT AND NOT OAUTH — settled 2026-08-05, do not re-litigate.
 * Google offers three ways in. Two of them are traps for an agent that runs
 * unattended on a cron:
 *  · A measurement ID (`G-XXXXXXX`) is what gtag.js uses to WRITE pageviews. It
 *    is public in the page source and cannot read a single number.
 *  · An OAuth client needs a human to click a consent screen, and a consent
 *    screen whose publishing status is "Testing" issues refresh tokens that
 *    EXPIRE IN 7 DAYS. The agent would go blind every week, silently, and the
 *    failure would present as an Artivio bug.
 *  · A service account signs a JWT and exchanges it for a fresh access token on
 *    every call. It uses no refresh token at all, so there is no expiry cliff
 *    and no human in the loop. That is the only correct answer here.
 *
 * WHY NOT THE OFFICIAL GOOGLE ANALYTICS MCP: it exists, but it is Python,
 * installed with pipx, over stdio. `stdioCatalog.ts` deliberately only resolves
 * entry scripts from npm packages pinned in OUR package.json and spawns
 * `process.execPath` — adding a Python runtime so we can spawn a third-party
 * process beside the vault master key is exactly what that boundary prevents.
 * Underneath it is one REST endpoint per question; an in-app adapter (ADR #3b)
 * is cheaper and meters nothing because these APIs are free.
 *
 * NO METERING ON PURPOSE: the GA4 Data API and the Search Console API are free
 * (quota-limited, not billed). There is no `units` to report and no price rule,
 * so none of the Phase 18 silent-$0 money-leak risk applies here.
 *
 * Per-connection config (stored on the mcp_connection, not the catalog):
 *   url        = the GA4 property ID, e.g. "531400000038" or "properties/531400000038"
 *   credential = the service account JSON key, verbatim (sealed in the vault)
 *
 * The SAME service account reaches Search Console — the site is not part of the
 * connection because one account often verifies several. `gsc_list_sites`
 * enumerates them at runtime instead (see the enumeration note below).
 */

import type { BuiltinProvider, BuiltinTool } from '@/libs/plugins/types';
import { createSign } from 'node:crypto';

const GA_DATA = 'https://analyticsdata.googleapis.com/v1beta';
const GSC = 'https://www.googleapis.com/webmasters/v3';
const SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
].join(' ');

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

function parseServiceAccount(credential: string): ServiceAccount {
  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(credential) as Partial<ServiceAccount>;
  } catch {
    throw new Error(
      'Google credential is not valid JSON. Paste the WHOLE service account key file (it starts with {"type":"service_account"...}), not just one field from it.',
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      'Google service account JSON is missing client_email or private_key. Re-download the key from Cloud Console → IAM → Service Accounts → Keys.',
    );
  }
  return {
    client_email: parsed.client_email,
    // Survives a key that was round-tripped through an env var, where the PEM
    // newlines end up as the two characters backslash-n.
    private_key: parsed.private_key.includes('\\n')
      ? parsed.private_key.replace(/\\n/g, '\n')
      : parsed.private_key,
    token_uri: parsed.token_uri ?? 'https://oauth2.googleapis.com/token',
  };
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Access tokens last an hour. Cache per service account so a mission that makes
// twenty GA calls in one step does not do twenty token exchanges.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const cached = tokenCache.get(sa.client_email);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt > now + 60) {
    return cached.token;
  }

  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const claims = {
    iss: sa.client_email,
    scope: SCOPES,
    aud: tokenUri,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;

  let signature: string;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    signature = b64url(signer.sign(sa.private_key));
  } catch {
    // Never echo the key material in the error.
    throw new Error('Could not sign with the service account private key — the key in the JSON looks malformed or truncated.');
  }

  const resp = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const body = await resp.text();
  if (!resp.ok) {
    let hint = '';
    if (body.includes('invalid_grant')) {
      hint = ' — the service account may be disabled, or the machine clock is skewed.';
    }
    if (body.includes('invalid_scope') || resp.status === 403) {
      hint = ' — enable the Google Analytics Data API and the Search Console API in this Cloud project.';
    }
    throw new Error(`Google token exchange failed (HTTP ${resp.status})${hint}: ${body.slice(0, 300)}`);
  }
  const json = JSON.parse(body) as { access_token: string; expires_in: number };
  tokenCache.set(sa.client_email, {
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600),
  });
  return json.access_token;
}

async function googleFetch(
  url: string,
  sa: ServiceAccount,
  init?: RequestInit,
): Promise<any> {
  const token = await getAccessToken(sa);
  const resp = await fetch(url, {
    ...init,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = JSON.parse(text) as { error?: { message?: string; status?: string } };
      if (j.error?.message) {
        msg = j.error.message;
      }
    } catch { /* keep the status */ }
    // These two are almost always the same missing click, so name it.
    if (resp.status === 403) {
      msg += ` — grant the service account (${sa.client_email}) Viewer access: GA4 Admin → Property Access Management, and Search Console → Settings → Users and permissions.`;
    }
    if (resp.status === 404) {
      msg += ' — check the property ID on the connection, or call gsc_list_sites to see which Search Console sites this account can actually read.';
    }
    throw new Error(`Google: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

function propertyPath(target?: string): string {
  const raw = (target ?? '').trim();
  if (!raw) {
    throw new Error('This connection has no GA4 property ID. Set it on the connection (Tools panel) — it is the numeric ID from GA4 Admin → Property Settings.');
  }
  const id = raw.replace(/^properties\//, '').replace(/\D/g, '');
  if (!id) {
    throw new Error(`"${raw}" is not a GA4 property ID. It is the numeric ID (e.g. 531400000038) from GA4 Admin → Property Settings — NOT the "G-…" measurement ID.`);
  }
  return `properties/${id}`;
}

/**
 * GA4 responses are extremely verbose — parallel header arrays plus per-cell
 * `{value}` wrappers. Flattening to plain rows costs a few lines here and saves
 * a large multiple of that in tokens on every single report the agent reads.
 */
function flattenGaReport(report: any): unknown {
  const dimHeaders: string[] = (report.dimensionHeaders ?? []).map((h: any) => h.name);
  const metHeaders: string[] = (report.metricHeaders ?? []).map((h: any) => h.name);
  const rows = (report.rows ?? []).map((row: any) => {
    const out: Record<string, string> = {};
    dimHeaders.forEach((name, i) => {
      out[name] = row.dimensionValues?.[i]?.value ?? '';
    });
    metHeaders.forEach((name, i) => {
      out[name] = row.metricValues?.[i]?.value ?? '';
    });
    return out;
  });
  return {
    rows,
    rowCount: report.rowCount ?? rows.length,
    ...(report.totals?.length ? { totals: report.totals[0].metricValues?.map((m: any) => m.value) } : {}),
  };
}

function dateRange(args: Record<string, unknown>) {
  return [{
    startDate: String(args.start_date || '28daysAgo'),
    endDate: String(args.end_date || 'yesterday'),
  }];
}

const tools: BuiltinTool[] = [
  {
    name: 'ga4_metadata',
    description:
      'List the dimensions and metrics THIS GA4 property actually supports, with descriptions. Call this first when you are unsure of an API name — GA4 has ~200 dimensions and ~100 metrics and inventing a name wastes a call. Supports custom dimensions defined on the property.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional case-insensitive substring to narrow the list, e.g. "session" or "conversion".' },
      },
    },
  },
  {
    name: 'ga4_run_report',
    description:
      'Run any GA4 report. Use ga4_metadata first if you are not certain a dimension/metric name is real. Dates accept YYYY-MM-DD or GA4 relative forms like "28daysAgo", "yesterday", "today".',
    input_schema: {
      type: 'object',
      properties: {
        metrics: { type: 'array', items: { type: 'string' }, description: 'GA4 metric API names, e.g. ["sessions","totalUsers","screenPageViews"].' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'GA4 dimension API names, e.g. ["date","pagePath","sessionDefaultChannelGroup"].' },
        start_date: { type: 'string', description: 'Default "28daysAgo".' },
        end_date: { type: 'string', description: 'Default "yesterday".' },
        limit: { type: 'number', description: 'Rows to return, default 50, max 500.' },
        order_by_metric: { type: 'string', description: 'Metric name to sort by, descending.' },
      },
      required: ['metrics'],
    },
  },
  {
    name: 'ga4_top_pages',
    description: 'Shortcut: the most-viewed pages with views, sessions, users, average engagement time and bounce rate. Use this instead of hand-building the common report.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        limit: { type: 'number', description: 'Default 25.' },
        path_contains: { type: 'string', description: 'Optional filter, e.g. "/blog/" to see only blog performance.' },
      },
    },
  },
  {
    name: 'ga4_traffic_sources',
    description: 'Shortcut: sessions, users and conversions broken down by channel group, source and medium — where the traffic actually came from.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        limit: { type: 'number', description: 'Default 25.' },
      },
    },
  },
  {
    name: 'ga4_realtime',
    description: 'Who is on the site right now (last 30 minutes). Useful immediately after publishing or sending a campaign.',
    input_schema: {
      type: 'object',
      properties: {
        dimensions: { type: 'array', items: { type: 'string' }, description: 'Default ["unifiedScreenName"].' },
      },
    },
  },
  {
    name: 'gsc_list_sites',
    description:
      'List the Search Console properties this service account can read, with the permission level for each. Call this before any other gsc_ tool — the exact site string (e.g. "sc-domain:budgetsmart.io" vs "https://budgetsmart.io/") must match exactly and cannot be guessed.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'gsc_top_queries',
    description:
      'THE SEO FEEDBACK LOOP: the search queries a site actually ranks for, with clicks, impressions, CTR and average position. This answers "is the content working", which GA4 cannot — GA4 only sees people who already arrived.',
    input_schema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Exact site string from gsc_list_sites.' },
        start_date: { type: 'string', description: 'YYYY-MM-DD. Default 28 days ago. Search Console data lags ~2 days.' },
        end_date: { type: 'string', description: 'YYYY-MM-DD. Default 3 days ago.' },
        limit: { type: 'number', description: 'Default 50, max 500.' },
        page_contains: { type: 'string', description: 'Optional: only queries that landed on URLs containing this, e.g. "/blog/".' },
      },
      required: ['site'],
    },
  },
  {
    name: 'gsc_page_performance',
    description: 'Search performance per URL — which pages earn impressions and clicks, and their average position. Use to find pages ranking on page 2 that are worth improving.',
    input_schema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Exact site string from gsc_list_sites.' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        limit: { type: 'number', description: 'Default 50.' },
      },
      required: ['site'],
    },
  },
  {
    name: 'gsc_search_analytics',
    description: 'General Search Console query with your own dimensions. Valid dimensions: query, page, country, device, date, searchAppearance.',
    input_schema: {
      type: 'object',
      properties: {
        site: { type: 'string' },
        dimensions: { type: 'array', items: { type: 'string' } },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['site', 'dimensions'],
    },
  },
];

function gscDates(args: Record<string, unknown>) {
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
  return {
    // Search Console finalises data with a ~2-day lag; asking for "today"
    // returns an empty set and reads as "the site got no traffic".
    startDate: String(args.start_date || day(28)),
    endDate: String(args.end_date || day(3)),
  };
}

async function gscQuery(sa: ServiceAccount, args: Record<string, unknown>, dimensions: string[]) {
  const site = String(args.site ?? '').trim();
  if (!site) {
    throw new Error('Search Console needs a site. Call gsc_list_sites first and pass the exact string it returns.');
  }
  const { startDate, endDate } = gscDates(args);
  const body: Record<string, unknown> = {
    startDate,
    endDate,
    dimensions,
    rowLimit: Math.min(Number(args.limit) || 50, 500),
  };
  if (args.page_contains) {
    body.dimensionFilterGroups = [{
      filters: [{ dimension: 'page', operator: 'contains', expression: String(args.page_contains) }],
    }];
  }
  const res = await googleFetch(
    `${GSC}/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    sa,
    { method: 'POST', body: JSON.stringify(body) },
  );
  const rows = (res.rows ?? []).map((r: any) => {
    const out: Record<string, unknown> = {};
    dimensions.forEach((d, i) => {
      out[d] = r.keys?.[i];
    });
    out.clicks = r.clicks;
    out.impressions = r.impressions;
    out.ctr = typeof r.ctr === 'number' ? `${(r.ctr * 100).toFixed(2)}%` : r.ctr;
    out.position = typeof r.position === 'number' ? Number(r.position.toFixed(1)) : r.position;
    return out;
  });
  return JSON.stringify({ site, startDate, endDate, rows, rowCount: rows.length });
}

export const googleAnalyticsProvider: BuiltinProvider = {
  slug: 'google-analytics',
  name: 'Google Analytics + Search Console',
  description:
    'Read GA4 traffic, engagement and conversions, and Search Console query rankings, for this workspace’s site. Read-only. Free — Google does not bill these APIs.',
  credentialLabel:
    'Service account JSON key (the whole file). Create it in Cloud Console → IAM → Service Accounts → Keys, then grant that service account Viewer on the GA4 property and add it as a user in Search Console.',
  perConnection: true,
  tools,

  async call(tool, args, credential, target) {
    const sa = parseServiceAccount(credential);

    if (tool === 'ga4_metadata') {
      const res = await googleFetch(`${GA_DATA}/${propertyPath(target)}/metadata`, sa);
      const needle = String(args.filter ?? '').toLowerCase();
      const pick = (list: any[]) => (list ?? [])
        .filter(x => !needle || `${x.apiName} ${x.uiName}`.toLowerCase().includes(needle))
        .map(x => ({ api: x.apiName, label: x.uiName, custom: x.customDefinition || undefined }));
      return JSON.stringify({
        dimensions: pick(res.dimensions),
        metrics: pick(res.metrics),
      });
    }

    if (tool === 'ga4_run_report' || tool === 'ga4_top_pages' || tool === 'ga4_traffic_sources') {
      let body: Record<string, unknown>;

      if (tool === 'ga4_top_pages') {
        body = {
          dateRanges: dateRange(args),
          dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
          metrics: ['screenPageViews', 'sessions', 'totalUsers', 'userEngagementDuration', 'bounceRate'].map(name => ({ name })),
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: Math.min(Number(args.limit) || 25, 500),
          ...(args.path_contains
            ? {
                dimensionFilter: {
                  filter: {
                    fieldName: 'pagePath',
                    stringFilter: { matchType: 'CONTAINS', value: String(args.path_contains) },
                  },
                },
              }
            : {}),
        };
      } else if (tool === 'ga4_traffic_sources') {
        body = {
          dateRanges: dateRange(args),
          dimensions: [{ name: 'sessionDefaultChannelGroup' }, { name: 'sessionSource' }, { name: 'sessionMedium' }],
          metrics: ['sessions', 'totalUsers', 'conversions'].map(name => ({ name })),
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: Math.min(Number(args.limit) || 25, 500),
        };
      } else {
        const metrics = (args.metrics as string[]) ?? [];
        if (!Array.isArray(metrics) || metrics.length === 0) {
          throw new Error('ga4_run_report needs at least one metric. Call ga4_metadata to see the real metric names for this property.');
        }
        body = {
          dateRanges: dateRange(args),
          metrics: metrics.map(name => ({ name })),
          dimensions: ((args.dimensions as string[]) ?? []).map(name => ({ name })),
          limit: Math.min(Number(args.limit) || 50, 500),
          ...(args.order_by_metric
            ? { orderBys: [{ metric: { metricName: String(args.order_by_metric) }, desc: true }] }
            : {}),
        };
      }

      const res = await googleFetch(`${GA_DATA}/${propertyPath(target)}:runReport`, sa, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return JSON.stringify(flattenGaReport(res));
    }

    if (tool === 'ga4_realtime') {
      const res = await googleFetch(`${GA_DATA}/${propertyPath(target)}:runRealtimeReport`, sa, {
        method: 'POST',
        body: JSON.stringify({
          dimensions: (((args.dimensions as string[]) ?? ['unifiedScreenName'])).map(name => ({ name })),
          metrics: [{ name: 'activeUsers' }],
        }),
      });
      return JSON.stringify(flattenGaReport(res));
    }

    if (tool === 'gsc_list_sites') {
      const res = await googleFetch(`${GSC}/sites`, sa);
      const entries = (res.siteEntry ?? []).map((s: any) => ({
        site: s.siteUrl,
        permission: s.permissionLevel,
      }));
      if (entries.length === 0) {
        return JSON.stringify({
          sites: [],
          note: `This service account (${sa.client_email}) is not a user on any Search Console property yet. Add it in Search Console → Settings → Users and permissions.`,
        });
      }
      return JSON.stringify({ sites: entries });
    }

    if (tool === 'gsc_top_queries') {
      return gscQuery(sa, args, ['query']);
    }

    if (tool === 'gsc_page_performance') {
      return gscQuery(sa, args, ['page']);
    }

    if (tool === 'gsc_search_analytics') {
      const dims = (args.dimensions as string[]) ?? [];
      if (!Array.isArray(dims) || dims.length === 0) {
        throw new Error('gsc_search_analytics needs at least one dimension: query, page, country, device, date or searchAppearance.');
      }
      return gscQuery(sa, args, dims);
    }

    throw new Error(`Unknown Google Analytics tool: ${tool}`);
  },
};
