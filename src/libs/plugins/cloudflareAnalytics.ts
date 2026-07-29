/**
 * Cloudflare Web Analytics — built-in provider (real traffic data).
 *
 * WHY: the agent needs real (near-realtime) traffic numbers for dashboards and
 * marketing decisions. budgetsmart.io and app.budgetsmart.io are proxied
 * through Cloudflare and Cloudflare Web Analytics (RUM) is already collecting,
 * so the data EXISTS — this provider reads it via Cloudflare's GraphQL
 * Analytics API. GA4 stays the deeper funnel source, but its API needs OAuth /
 * service-account auth that Artivio doesn't do; Cloudflare needs one static
 * API token, which fits the platform's vault exactly.
 *
 * Per-connection provider (like WordPress): each workspace supplies
 *   target (the connection's url field): "<accountTag>/<siteTag>"
 *     e.g. 711303ba637d386edfffed9520418bdf/45ad259fedaa47dc917a56a4aff995c7
 *   credential: a Cloudflare API token with Account Analytics : Read
 *     (dash.cloudflare.com → My Profile → API Tokens → Create Token).
 *
 * Data: rumPageloadEventsAdaptiveGroups (page views = count, visits = sum.visits)
 * over the GraphQL endpoint https://api.cloudflare.com/client/v4/graphql.
 * RUM events land within minutes — "near realtime". Adaptive datasets are
 * sampled at very high volume; at this site's scale numbers are effectively
 * exact. If Cloudflare rejects a dimension name the GraphQL error is surfaced
 * verbatim so the operator can correct this adapter quickly.
 */

import type { BuiltinProvider } from '@/libs/plugins/types';

const GQL = 'https://api.cloudflare.com/client/v4/graphql';

type Dim = 'datetimeFifteenMinutes' | 'date' | 'requestPath' | 'refererHost' | 'countryName' | 'deviceType' | 'userAgentBrowser';

function parseTarget(target?: string): { account: string; site: string } {
  const [account, site] = String(target ?? '').split('/').map(s => s.trim()).filter(Boolean);
  if (!account || !site) {
    throw new Error('Cloudflare Analytics connection is missing its target. Set the connection URL field to "<accountTag>/<siteTag>" (Account ID from the dashboard URL, site tag from Web Analytics).');
  }
  return { account, site };
}

function isoAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

async function rumQuery(
  token: string,
  account: string,
  site: string,
  sinceHours: number,
  dims: Dim[],
  limit: number,
): Promise<any[]> {
  const dimBlock = dims.length > 0 ? `dimensions { ${dims.join(' ')} }` : '';
  const query = `query Rum($account: String!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
    viewer { accounts(filter: { accountTag: $account }) {
      rumPageloadEventsAdaptiveGroups(filter: $filter, limit: ${limit}) {
        count
        sum { visits }
        ${dimBlock}
      }
    } }
  }`;
  const variables = {
    account,
    filter: { AND: [{ siteTag: site }, { datetime_geq: isoAgo(sinceHours) }, { datetime_leq: new Date(Date.now()).toISOString() }] },
  };
  const resp = await fetch(GQL, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await resp.json().catch(() => ({})) as Record<string, any>;
  if (!resp.ok) {
    throw new Error(`Cloudflare API ${resp.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    // Surface GraphQL errors verbatim — they name the exact field at fault.
    throw new Error(`Cloudflare GraphQL: ${body.errors.map((e: any) => e.message).join(' | ').slice(0, 400)}`);
  }
  return body.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups ?? [];
}

function totals(rows: any[]) {
  const pageviews = rows.reduce((a, r) => a + (r.count ?? 0), 0);
  const visits = rows.reduce((a, r) => a + (r.sum?.visits ?? 0), 0);
  return { pageviews, visits };
}

export const cloudflareAnalyticsProvider: BuiltinProvider = {
  slug: 'cloudflare-analytics',
  name: 'Cloudflare Web Analytics (site traffic)',
  description:
    'Real visitor data for the marketing site — near-realtime page views, visits, top pages, referrers, countries and devices, straight from Cloudflare Web Analytics.',
  credentialLabel:
    'A Cloudflare API token with "Account Analytics : Read" (dash.cloudflare.com → My Profile → API Tokens). Raw token — no "Bearer" prefix.',
  perConnection: true,

  tools: [
    {
      name: 'traffic_now',
      description: 'Near-realtime traffic pulse: page views and visits over the last hour in 15-minute buckets, plus the most recent bucket highlighted. Use for "what\'s happening right now".',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'traffic_overview',
      description: 'Traffic summary for a window (default 24h): total page views + visits and a 15-minute or daily time series. Use for dashboards and trend questions.',
      input_schema: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: 'Lookback window in hours (1–720). Default 24. Windows over 72h aggregate by day.' },
        },
      },
    },
    {
      name: 'top_pages',
      description: 'Most-viewed paths in a window (default 24h) with page views and visits per path.',
      input_schema: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: 'Lookback in hours. Default 24.' },
          limit: { type: 'number', description: 'Max rows (default 15).' },
        },
      },
    },
    {
      name: 'traffic_sources',
      description: 'Where visitors come from in a window (default 24h): referrer hosts, countries, and device types with visit counts.',
      input_schema: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: 'Lookback in hours. Default 24.' },
        },
      },
    },
  ],

  call: async (tool, args, credential, target): Promise<string> => {
    const token = (credential ?? '').trim();
    if (!token) {
      throw new Error('No Cloudflare API token configured for this plugin.');
    }
    const { account, site } = parseTarget(target);
    const hours = Math.min(720, Math.max(1, Number(args.hours ?? 24) || 24));

    if (tool === 'traffic_now') {
      const rows = await rumQuery(token, account, site, 1, ['datetimeFifteenMinutes'], 8);
      rows.sort((a, b) => String(a.dimensions?.datetimeFifteenMinutes ?? '').localeCompare(String(b.dimensions?.datetimeFifteenMinutes ?? '')));
      const t = totals(rows);
      const latest = rows[rows.length - 1];
      return JSON.stringify({
        window: 'last 60 minutes',
        pageviews: t.pageviews,
        visits: t.visits,
        by_15min: rows.map(r => ({ bucket: r.dimensions?.datetimeFifteenMinutes, pageviews: r.count, visits: r.sum?.visits ?? 0 })),
        latest_bucket: latest ? { bucket: latest.dimensions?.datetimeFifteenMinutes, pageviews: latest.count, visits: latest.sum?.visits ?? 0 } : null,
        note: 'Cloudflare Web Analytics (RUM). Events land within a few minutes — treat as near-realtime.',
      });
    }

    if (tool === 'traffic_overview') {
      const dim: Dim = hours > 72 ? 'date' : 'datetimeFifteenMinutes';
      const rows = await rumQuery(token, account, site, hours, [dim], 500);
      rows.sort((a, b) => String(a.dimensions?.[dim] ?? '').localeCompare(String(b.dimensions?.[dim] ?? '')));
      const t = totals(rows);
      return JSON.stringify({
        window_hours: hours,
        pageviews: t.pageviews,
        visits: t.visits,
        series: rows.map(r => ({ bucket: r.dimensions?.[dim], pageviews: r.count, visits: r.sum?.visits ?? 0 })),
      });
    }

    if (tool === 'top_pages') {
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 15) || 15));
      const rows = await rumQuery(token, account, site, hours, ['requestPath'], limit * 3);
      rows.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
      return JSON.stringify({
        window_hours: hours,
        pages: rows.slice(0, limit).map(r => ({ path: r.dimensions?.requestPath, pageviews: r.count, visits: r.sum?.visits ?? 0 })),
      });
    }

    if (tool === 'traffic_sources') {
      const [refs, countries, devices] = await Promise.all([
        rumQuery(token, account, site, hours, ['refererHost'], 20),
        rumQuery(token, account, site, hours, ['countryName'], 20),
        rumQuery(token, account, site, hours, ['deviceType'], 10),
      ]);
      const shape = (rows: any[], key: Dim) => rows
        .sort((a, b) => (b.sum?.visits ?? 0) - (a.sum?.visits ?? 0))
        .map(r => ({ [key]: r.dimensions?.[key] || '(direct/none)', visits: r.sum?.visits ?? 0, pageviews: r.count }));
      return JSON.stringify({
        window_hours: hours,
        referrers: shape(refs, 'refererHost'),
        countries: shape(countries, 'countryName'),
        devices: shape(devices, 'deviceType'),
      });
    }

    throw new Error(`Unknown Cloudflare Analytics tool: ${tool}`);
  },
};
