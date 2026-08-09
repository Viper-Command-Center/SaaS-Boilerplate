/**
 * DataForSEO — built-in provider (tier 1, platform credential, metered).
 *
 * WHY BUILT-IN: DataForSEO publishes no hosted MCP, and its API is a plain
 * JSON-over-HTTPS surface with HTTP Basic auth — exactly the shape ADR #3b
 * says to adapt in-app rather than wrap in a service.
 *
 * 🔑 WHY IT IS METERED, AND WHY THAT IS EASY HERE: every DataForSEO response
 * carries a `cost` field in REAL US DOLLARS, both per-task and totalled at the
 * top level. That is in-band metering of the same quality as Kie's
 * `creditsConsumed` — the property CLAUDE.md calls the best of anyone surveyed,
 * and the reason we stayed on Kie. So `units` here is literally dollars spent,
 * priced at $1 per unit, and the workspace is billed the true cost times the
 * markup. No price table to maintain, nothing to go stale.
 *
 * Credential: DataForSEO's own dashboard shows an API login (an email) and an
 * API password, and separately offers a pre-encoded Base64 blob. Both are
 * accepted — see `authHeader()`.
 *
 * 🔴 EVERY TOOL USES A `/live` ENDPOINT. DataForSEO's cheaper task_post /
 * task_get pattern is asynchronous: you submit, poll, and collect later. That
 * cannot work inside a single agent turn, and a half-finished poll loop would
 * burn tool iterations to return nothing. Live costs a little more per call and
 * returns inside one request. If a future tool genuinely needs the async
 * endpoints it needs the Phase 18 reconciliation path too — see
 * BuiltinResult.pendingReconcile — not a retry loop.
 */

import type { BuiltinProvider } from '@/libs/plugins/types';

const BASE = 'https://api.dataforseo.com/v3';
const TIMEOUT_MS = 60_000;

/**
 * DataForSEO wants `Authorization: Basic <base64(login:password)>`.
 *
 * Their dashboard shows the two parts separately AND a ready-made Base64 blob,
 * and people paste whichever they happened to be looking at. A colon is the
 * tell: it cannot appear in Base64's alphabet, so a credential containing one
 * is a raw `login:password` pair and gets encoded here. Anything else is
 * assumed to be already encoded. Guessing wrong in either direction produces a
 * 401 that looks like a wrong password, so it is worth handling both.
 */
function authHeader(credential: string): string {
  const raw = credential.trim();
  const encoded = raw.includes(':') ? Buffer.from(raw).toString('base64') : raw;
  return `Basic ${encoded}`;
}

type Envelope = {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    cost?: number;
    result?: unknown;
  }>;
};

/** One live POST. Returns the first task's result plus what the call cost. */
async function call(
  credential: string,
  path: string,
  payload: Record<string, unknown>,
): Promise<{ result: any; cost: number }> {
  let resp: Response;
  try {
    resp = await fetch(`${BASE}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Authorization': authHeader(credential),
        'Content-Type': 'application/json',
      },
      // Every DataForSEO endpoint takes an ARRAY of task objects, even for one
      // task. Sending the bare object returns a confusing 40501.
      body: JSON.stringify([payload]),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TypeError(`DataForSEO: could not reach the API — ${msg}`);
  }

  const text = await resp.text();
  let body: Envelope = {};
  try {
    body = JSON.parse(text) as Envelope;
  } catch { /* fall through to the status-based error below */ }

  if (!resp.ok) {
    const detail = body.status_message ?? text.slice(0, 200);
    let msg = `DataForSEO: HTTP ${resp.status}${detail ? ` — ${detail}` : ''}`;
    if (resp.status === 401) {
      msg += ' — check the API login and password on the DataForSEO catalog entry. The login is the ACCOUNT EMAIL (e.g. you@example.com) and the password is the API password from dataforseo.com → API Access, not the dashboard login password.';
    }
    throw new Error(msg);
  }

  /**
   * 20000 is DataForSEO's "ok". Anything else is an error delivered with HTTP
   * 200, so checking resp.ok alone would treat a hard failure as data — and
   * the agent would summarise an empty result as if it meant "no keywords".
   */
  if (body.status_code !== 20000) {
    throw new Error(`DataForSEO: ${body.status_code} — ${body.status_message ?? 'unknown API error'}`);
  }

  const task = body.tasks?.[0];
  // The cost is already charged whether or not the TASK succeeded, so read it
  // before the task-level check: billing the workspace for a failed call is
  // wrong, but so is quietly eating a cost we actually paid.
  const cost = Number(body.cost ?? task?.cost ?? 0) || 0;

  if (!task) {
    throw new Error('DataForSEO: the API returned no task.');
  }
  if (task.status_code !== 20000) {
    throw new Error(`DataForSEO: ${task.status_code} — ${task.status_message ?? 'task failed'}`);
  }

  return { result: (task.result as any) ?? null, cost };
}

function loc(args: Record<string, unknown>): Record<string, string> {
  return {
    location_name: String(args.location ?? 'United States'),
    language_name: String(args.language ?? 'English'),
  };
}

function cap(n: unknown, fallback: number, max: number): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), max) : fallback;
}

function round(n: unknown, dp = 2): number | null {
  const v = Number(n);
  return Number.isFinite(v) ? Number(v.toFixed(dp)) : null;
}

const LOCATION_ARG = {
  location: { type: 'string', description: 'Country or city name exactly as DataForSEO spells it, e.g. "United States", "Canada", "United Kingdom". Default "United States" — set it, because volumes differ enormously by market.' },
  language: { type: 'string', description: 'Language name, e.g. "English", "French". Default "English".' },
} as const;

export const dataforseoProvider: BuiltinProvider = {
  slug: 'dataforseo',
  name: 'DataForSEO (keyword + SERP research)',
  description:
    'Real search data for deciding what to write and how to rank: keyword search volume, CPC and difficulty, keyword ideas and long-tail suggestions, live Google SERPs, what a domain already ranks for, and who its organic competitors are. Billed by DataForSEO per request — usually a fraction of a cent — and metered exactly, because every response reports its own cost in dollars.',
  credentialLabel:
    'Your DataForSEO API login and password as "email:password" (dataforseo.com → API Access → API CREDENTIALS). The ready-made Base64 blob from that same page is also accepted. NOT your dashboard login password.',

  usageMetering: {
    unitLabel: 'API dollar',
    defaultUnitCostUsd: 1,
    note: 'DataForSEO reports the exact dollar cost of every request in the response, so units here ARE dollars and the unit cost is $1. The workspace is billed true cost times your markup — no price table to maintain.',
  },

  guidance: `DataForSEO connection:
- This is RESEARCH data, not a publishing tool. Use it to decide what to write and which terms to target, then use the WordPress or Elementor tools to act on the answer.
- ALWAYS set \`location\` (and \`language\` if not English). The default is the United States, and search volumes differ enormously by market — a Canadian clinic planned against US volumes is planned against the wrong numbers.
- Sensible order for "what should we write next": keyword_ideas or keyword_suggestions from a seed → keyword_volume on the shortlist → keyword_difficulty to drop what you cannot rank for → serp_overview on the two or three survivors to see what actually ranks and what shape the winning page takes.
- serp_overview is the one that answers "what does a page that ranks for this look like". Read the titles before writing yours.
- ranked_keywords on the client's OWN domain finds pages already ranking on page two — usually cheaper wins than new articles.
- Every response reports what the call cost. Volumes are monthly averages from Google, not live traffic, and difficulty is a 0-100 estimate, not a promise; say so when reporting numbers to a client.`,

  tools: [
    {
      name: 'keyword_volume',
      description: 'Monthly search volume, CPC and competition for specific keywords you already have. Use when you have a shortlist and need the real numbers. For DISCOVERING keywords, use keyword_ideas or keyword_suggestions instead.',
      input_schema: {
        type: 'object',
        properties: {
          keywords: { type: 'array', items: { type: 'string' }, description: 'Up to 200 keywords.' },
          ...LOCATION_ARG,
        },
        required: ['keywords'],
      },
    },
    {
      name: 'keyword_ideas',
      description: 'Keywords Google associates with your seed terms — the broad "what else could we write about" sweep. Returns volume and competition with each idea. Give one to five seeds.',
      input_schema: {
        type: 'object',
        properties: {
          keywords: { type: 'array', items: { type: 'string' }, description: '1-5 seed keywords.' },
          limit: { type: 'number', description: 'Max ideas (default 50, max 200).' },
          ...LOCATION_ARG,
        },
        required: ['keywords'],
      },
    },
    {
      name: 'keyword_suggestions',
      description: 'Long-tail phrases CONTAINING your seed keyword — the "what exactly are people asking" list. Narrower and more literal than keyword_ideas, and usually where the winnable article topics are.',
      input_schema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'A single seed keyword.' },
          limit: { type: 'number', description: 'Max suggestions (default 50, max 200).' },
          ...LOCATION_ARG,
        },
        required: ['keyword'],
      },
    },
    {
      name: 'keyword_difficulty',
      description: 'How hard it would be to rank on page one for each keyword, 0-100. Run it on a shortlist before committing to write: a 2,000-a-month keyword at difficulty 85 is worth less to a small site than a 200-a-month keyword at 15.',
      input_schema: {
        type: 'object',
        properties: {
          keywords: { type: 'array', items: { type: 'string' }, description: 'Up to 100 keywords.' },
          ...LOCATION_ARG,
        },
        required: ['keywords'],
      },
    },
    {
      name: 'serp_overview',
      description: 'The live Google results page for one keyword: who ranks, their titles, URLs and snippets, plus which SERP features are present. This is what tells you the SHAPE of a page that ranks — read the ranking titles before writing yours. Costs more per call than the keyword tools, so use it on a shortlist, not a list.',
      input_schema: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          depth: { type: 'number', description: 'How many results to examine (default 20, max 100).' },
          ...LOCATION_ARG,
        },
        required: ['keyword'],
      },
    },
    {
      name: 'ranked_keywords',
      description: 'What a domain ALREADY ranks for, with position and volume. Run it on the client\'s own site first: keywords sitting at positions 5-20 are usually cheaper wins than new articles, because the page already exists and only needs improving.',
      input_schema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Domain without protocol, e.g. "budgetsmart.io".' },
          limit: { type: 'number', description: 'Max keywords (default 50, max 200).' },
          ...LOCATION_ARG,
        },
        required: ['domain'],
      },
    },
    {
      name: 'competitor_domains',
      description: 'Domains competing for the same organic keywords as a given site, with how much they overlap. Use it to find who to study, then run ranked_keywords on the strongest one to see what is working for them.',
      input_schema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Domain without protocol.' },
          limit: { type: 'number', description: 'Max competitors (default 20, max 100).' },
          ...LOCATION_ARG,
        },
        required: ['domain'],
      },
    },
    {
      name: 'domain_overview',
      description: 'A domain\'s organic footprint at a glance: how many keywords it ranks for, estimated monthly traffic, and the spread across position buckets. Good for sizing up a competitor, or for a before/after on the client\'s own site.',
      input_schema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Domain without protocol.' },
          ...LOCATION_ARG,
        },
        required: ['domain'],
      },
    },
  ],

  call: async (tool, args, credential) => {
    if (!credential?.trim()) {
      throw new Error('DataForSEO: no API credential configured on the catalog entry.');
    }

    /**
     * Everything below trims hard before returning. A single DataForSEO
     * response can run to several hundred KB — SERP results alone carry
     * per-result rank groups, extended snippets, ratings and link arrays. The
     * agent needs the handful of fields that inform a decision, and handing it
     * the rest would spend the context window on data nobody reads.
     */
    if (tool === 'keyword_volume') {
      const keywords = (Array.isArray(args.keywords) ? args.keywords : []).map(String).slice(0, 200);
      if (keywords.length === 0) {
        throw new Error('DataForSEO: give at least one keyword.');
      }
      const { result, cost } = await call(credential, '/keywords_data/google_ads/search_volume/live', {
        keywords,
        ...loc(args),
      });
      const rows = (Array.isArray(result) ? result : []).map((r: any) => ({
        keyword: r?.keyword,
        volume: r?.search_volume ?? null,
        cpc: round(r?.cpc),
        competition: r?.competition ?? null,
        competitionIndex: r?.competition_index ?? null,
      }));
      return {
        output: JSON.stringify({
          location: loc(args).location_name,
          keywords: rows,
          note: 'Volume is Google\'s average monthly searches over the last 12 months, not live traffic.',
        }),
        units: cost,
      };
    }

    if (tool === 'keyword_ideas' || tool === 'keyword_suggestions') {
      const isIdeas = tool === 'keyword_ideas';
      const limit = cap(args.limit, 50, 200);
      const payload = isIdeas
        ? {
            keywords: (Array.isArray(args.keywords) ? args.keywords : []).map(String).slice(0, 5),
            limit,
            ...loc(args),
          }
        : { keyword: String(args.keyword ?? ''), limit, ...loc(args) };

      if (isIdeas && (payload as any).keywords.length === 0) {
        throw new Error('DataForSEO: give at least one seed keyword.');
      }
      if (!isIdeas && !(payload as any).keyword) {
        throw new Error('DataForSEO: give a seed keyword.');
      }

      const path = isIdeas
        ? '/dataforseo_labs/google/keyword_ideas/live'
        : '/dataforseo_labs/google/keyword_suggestions/live';
      const { result, cost } = await call(credential, path, payload);

      const items = result?.[0]?.items ?? [];
      const rows = (Array.isArray(items) ? items : []).slice(0, limit).map((r: any) => ({
        keyword: r?.keyword_data?.keyword ?? r?.keyword,
        volume: r?.keyword_data?.keyword_info?.search_volume ?? null,
        cpc: round(r?.keyword_data?.keyword_info?.cpc),
        competition: r?.keyword_data?.keyword_info?.competition ?? null,
        difficulty: r?.keyword_data?.keyword_properties?.keyword_difficulty ?? null,
      }));
      return {
        output: JSON.stringify({
          seed: isIdeas ? (payload as any).keywords : (payload as any).keyword,
          location: loc(args).location_name,
          returned: rows.length,
          totalAvailable: result?.[0]?.total_count ?? null,
          keywords: rows,
        }),
        units: cost,
      };
    }

    if (tool === 'keyword_difficulty') {
      const keywords = (Array.isArray(args.keywords) ? args.keywords : []).map(String).slice(0, 100);
      if (keywords.length === 0) {
        throw new Error('DataForSEO: give at least one keyword.');
      }
      const { result, cost } = await call(credential, '/dataforseo_labs/google/bulk_keyword_difficulty/live', {
        keywords,
        ...loc(args),
      });
      const items = result?.[0]?.items ?? [];
      return {
        output: JSON.stringify({
          location: loc(args).location_name,
          keywords: (Array.isArray(items) ? items : []).map((r: any) => ({
            keyword: r?.keyword,
            difficulty: r?.keyword_difficulty ?? null,
          })),
          note: 'Difficulty is a 0-100 estimate of how hard page one would be, not a guarantee. Under ~30 is realistic for a small site; over ~60 needs real authority.',
        }),
        units: cost,
      };
    }

    if (tool === 'serp_overview') {
      const keyword = String(args.keyword ?? '').trim();
      if (!keyword) {
        throw new Error('DataForSEO: give a keyword.');
      }
      const depth = cap(args.depth, 20, 100);
      const { result, cost } = await call(credential, '/serp/google/organic/live/advanced', {
        keyword,
        depth,
        ...loc(args),
      });

      const items = result?.[0]?.items ?? [];
      const all = Array.isArray(items) ? items : [];
      const organic = all
        .filter((i: any) => i?.type === 'organic')
        .slice(0, 10)
        .map((i: any) => ({
          position: i?.rank_absolute ?? null,
          title: i?.title ?? null,
          url: i?.url ?? null,
          domain: i?.domain ?? null,
          snippet: typeof i?.description === 'string' ? i.description.slice(0, 200) : null,
        }));
      // Which SERP features are present matters as much as the ranking pages:
      // a keyword whose page one is mostly video or shopping is a poor target
      // for a written article no matter how good its volume looks.
      const features = [...new Set(all.map((i: any) => String(i?.type ?? '')).filter(Boolean))]
        .filter(t => t !== 'organic')
        .slice(0, 15);

      return {
        output: JSON.stringify({
          keyword,
          location: loc(args).location_name,
          totalResults: result?.[0]?.se_results_count ?? null,
          serpFeatures: features,
          topOrganic: organic,
          note: 'Read the ranking titles before writing yours. If serpFeatures is dominated by video, shopping or local packs, a written article may not be the right format for this keyword.',
        }),
        units: cost,
      };
    }

    if (tool === 'ranked_keywords') {
      const domain = String(args.domain ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      if (!domain) {
        throw new Error('DataForSEO: give a domain, without the protocol.');
      }
      const limit = cap(args.limit, 50, 200);
      const { result, cost } = await call(credential, '/dataforseo_labs/google/ranked_keywords/live', {
        target: domain,
        limit,
        ...loc(args),
      });
      const items = result?.[0]?.items ?? [];
      const rows = (Array.isArray(items) ? items : []).slice(0, limit).map((r: any) => ({
        keyword: r?.keyword_data?.keyword,
        position: r?.ranked_serp_element?.serp_item?.rank_absolute ?? null,
        url: r?.ranked_serp_element?.serp_item?.url ?? null,
        volume: r?.keyword_data?.keyword_info?.search_volume ?? null,
        difficulty: r?.keyword_data?.keyword_properties?.keyword_difficulty ?? null,
      }));
      const nearMisses = rows.filter(r => typeof r.position === 'number' && r.position >= 5 && r.position <= 20).length;
      return {
        output: JSON.stringify({
          domain,
          location: loc(args).location_name,
          totalKeywords: result?.[0]?.total_count ?? null,
          returned: rows.length,
          keywords: rows,
          hint: `${nearMisses} of these sit at positions 5-20. Improving an existing page that already ranks there is usually cheaper than writing a new article.`,
        }),
        units: cost,
      };
    }

    if (tool === 'competitor_domains') {
      const domain = String(args.domain ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      if (!domain) {
        throw new Error('DataForSEO: give a domain, without the protocol.');
      }
      const limit = cap(args.limit, 20, 100);
      const { result, cost } = await call(credential, '/dataforseo_labs/google/competitors_domain/live', {
        target: domain,
        limit,
        ...loc(args),
      });
      const items = result?.[0]?.items ?? [];
      return {
        output: JSON.stringify({
          domain,
          location: loc(args).location_name,
          competitors: (Array.isArray(items) ? items : []).slice(0, limit).map((r: any) => ({
            domain: r?.domain,
            sharedKeywords: r?.intersections ?? null,
            theirKeywords: r?.metrics?.organic?.count ?? null,
            theirEstimatedTraffic: r?.metrics?.organic?.etv ? Math.round(r.metrics.organic.etv) : null,
          })),
        }),
        units: cost,
      };
    }

    if (tool === 'domain_overview') {
      const domain = String(args.domain ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      if (!domain) {
        throw new Error('DataForSEO: give a domain, without the protocol.');
      }
      const { result, cost } = await call(credential, '/dataforseo_labs/google/domain_rank_overview/live', {
        target: domain,
        ...loc(args),
      });
      const m = result?.[0]?.items?.[0]?.metrics?.organic ?? null;
      return {
        output: JSON.stringify({
          domain,
          location: loc(args).location_name,
          organic: m
            ? {
                keywords: m.count ?? null,
                estimatedMonthlyTraffic: m.etv ? Math.round(m.etv) : null,
                estimatedTrafficValueUsd: m.estimated_paid_traffic_cost ? Math.round(m.estimated_paid_traffic_cost) : null,
                positions1to3: m.pos_1 != null ? (m.pos_1 + (m.pos_2_3 ?? 0)) : null,
                positions4to10: m.pos_4_10 ?? null,
                positions11to20: m.pos_11_20 ?? null,
              }
            : null,
          note: 'Traffic and value are DataForSEO estimates modelled from ranking positions, not measured analytics. Use GA4 for what actually happened.',
        }),
        units: cost,
      };
    }

    throw new Error(`Unknown DataForSEO tool: ${tool}`);
  },
};
