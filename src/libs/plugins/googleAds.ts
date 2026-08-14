/**
 * Google Ads — built-in provider (per-connection).
 *
 * 🔴 THIS ADAPTER SPENDS A CLIENT'S MONEY. Read this before changing anything.
 *
 * Every other write adapter in this platform damages something recoverable: a
 * page can be reverted, a DNS record put back, a row restored from a backup.
 * Money that Google has already spent on clicks is gone, it leaves at up to the
 * daily budget per day whether or not anyone is watching, and the mistake that
 * spends it is usually silent — a budget that reads as reasonable in one unit
 * and catastrophic in another.
 *
 * That unit is the reason most of this file exists.
 *
 * ── MICROS ────────────────────────────────────────────────────────────────
 * The Google Ads API denominates all money in MICROS: 1,000,000 micros = one
 * unit of account currency. So a $150/day budget is 150000000. The two failure
 * directions are not symmetric, and both are quiet:
 *
 *   · Sending 150 where micros are expected sets a budget of $0.00015. Nothing
 *     breaks, no error is returned, the campaign simply stops serving. The
 *     agent reports success and the client's ads are off for a week.
 *   · Sending 150000000 where a plain amount was intended sets a $150,000,000
 *     daily budget. Google accepts it. Spend is then bounded only by how much
 *     inventory exists.
 *
 * A prompt cannot be trusted to hold that conversion straight across a long
 * agentic run, and no approval screen makes `amountMicros: 150000000` read as
 * either obviously right or obviously wrong to a human skimming it.
 *
 * So: this adapter's tools take PLAIN CURRENCY AMOUNTS — 150 means $150 — and
 * convert internally. Any argument that looks like micros is REFUSED rather
 * than converted, because a caller passing 150000000 has already lost track of
 * which unit it is in and guessing on its behalf is how the $150,000,000 budget
 * gets set.
 *
 * ── THE OTHER GUARDRAILS ──────────────────────────────────────────────────
 *  · Ceilings live on the CONNECTION, not in the prompt. maxDailyBudget and
 *    maxCpc are part of the target string; the adapter refuses to cross them
 *    no matter what any instruction says. Guardrails written in a system
 *    prompt are advisory, and an agent reasoning its way past one is a normal
 *    Tuesday.
 *  · Turning spend ON is always explicit. Enabling a paused campaign is the one
 *    action that converts a configuration mistake into money, so it needs
 *    confirm_spend even though pausing needs nothing.
 *  · The customer id comes from the connection, never from an argument. A
 *    mutate aimed at a customer id the agent supplied is a mutate that can land
 *    in another advertiser's account.
 *  · Every mutate supports preview: true → Google's validateOnly. The change is
 *    validated against the live account and discarded.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 * Keyword ideas and search-volume forecasting. Those live in Google's PLANNING
 * services, which an Explorer-level developer token is blocked from calling —
 * and Explorer is the level most people actually get. Zernio proxies Keyword
 * Planner under its own approved token, so keyword DISCOVERY belongs there and
 * keyword ECONOMICS (what is actually being spent, on what, to what effect)
 * belongs here. See `guidance` below.
 *
 * Credential: four lines of key=value (see CREDENTIAL_KEYS).
 * Target: "<customerId> | maxDailyBudget=… maxCpc=… [loginCustomerId=…]"
 */

import type { BuiltinProvider, BuiltinTool } from '@/libs/plugins/types';

const API_VERSION = 'v25';
const API = `https://googleads.googleapis.com/${API_VERSION}`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_OUTPUT = 60_000;

const MICROS = 1_000_000;

/**
 * Above this, a "plain amount" is almost certainly micros that someone forgot
 * to convert. No small business sets a five-million-dollar keyword bid or daily
 * budget, and the cost of refusing a real one (an error message) is nothing
 * next to the cost of accepting a fake one.
 */
const IMPLAUSIBLE_AMOUNT = 100_000;

const CREDENTIAL_KEYS = ['developer_token', 'client_id', 'client_secret', 'refresh_token'] as const;

type Creds = Record<(typeof CREDENTIAL_KEYS)[number], string>;

type Target = {
  customerId: string;
  loginCustomerId?: string;
  maxDailyBudget: number;
  maxCpc: number;
};

function parseCredential(raw: string | undefined): Creds {
  const text = String(raw ?? '').trim();
  if (!text) {
    throw new Error('Google Ads: no credential on this connection.');
  }

  const out: Record<string, string> = {};
  for (const line of text.split(/[\r\n]+/)) {
    const at = line.indexOf('=');
    if (at === -1) {
      continue;
    }
    out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }

  const missing = CREDENTIAL_KEYS.filter(k => !out[k]);
  if (missing.length > 0) {
    throw new Error(
      `Google Ads: the credential is missing ${missing.join(', ')}. It must be four lines of key=value: `
      + `${CREDENTIAL_KEYS.join(', ')}. This is a workspace-admin fix, not something to work around.`,
    );
  }

  return out as Creds;
}

/** Strip hyphens — Google rejects "123-456-7890" in headers and paths. */
function digits(v: unknown): string {
  return String(v ?? '').replace(/\D+/g, '');
}

/**
 * "1234567890 | maxDailyBudget=200 maxCpc=8 loginCustomerId=9876543210"
 *
 * The ceilings are REQUIRED. A connection without them would be an adapter with
 * no upper bound on spend, and the moment to decide what "too much" means is
 * while setting the account up — calmly, once — not inside an agent's run.
 */
function parseTarget(raw: string | undefined): Target {
  const text = String(raw ?? '').trim();
  if (!text) {
    throw new Error(
      'Google Ads: this connection has no account set. Its target must be '
      + '"<customerId> | maxDailyBudget=<amount> maxCpc=<amount>".',
    );
  }

  const [left, right = ''] = text.split('|').map(s => s.trim());
  const customerId = digits(left);
  if (customerId.length !== 10) {
    throw new Error(`Google Ads: "${left}" is not a 10-digit customer id (hyphens are fine, e.g. 123-456-7890).`);
  }

  const num = (key: string): number | null => {
    const m = new RegExp(`${key}\\s*=\\s*([0-9.]+)`, 'i').exec(right);
    return m?.[1] ? Number(m[1]) : null;
  };

  const maxDailyBudget = num('maxDailyBudget');
  const maxCpc = num('maxCpc');

  if (maxDailyBudget === null || maxCpc === null || !(maxDailyBudget > 0) || !(maxCpc > 0)) {
    throw new Error(
      'Google Ads: this connection must declare spend ceilings in its target, e.g. '
      + '"1234567890 | maxDailyBudget=200 maxCpc=8". Both are plain currency amounts. '
      + 'Without them the adapter has no upper bound on what it may set.',
    );
  }

  const login = /loginCustomerId\s*=\s*([\d-]+)/i.exec(right)?.[1];

  return {
    customerId,
    loginCustomerId: login ? digits(login) : undefined,
    maxDailyBudget,
    maxCpc,
  };
}

/**
 * A plain currency amount → micros, refusing anything that is already micros.
 *
 * `label` names the argument so the refusal points at the thing to change.
 */
export function toMicros(value: unknown, label: string, ceiling: number): number {
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Google Ads: ${label} must be a positive amount, got ${JSON.stringify(value)}.`);
  }

  /**
   * The load-bearing refusal. 150000000 is a perfectly ordinary micros value
   * and a catastrophic dollar value, and the two are indistinguishable from
   * inside this function — so it refuses instead of picking.
   */
  if (n >= IMPLAUSIBLE_AMOUNT) {
    throw new Error(
      `Google Ads: ${label} = ${n} looks like MICROS, not an amount. This tool takes plain currency — `
      + '150 means $150/day. Nothing was changed. If you genuinely meant an amount this large, it exceeds '
      + 'what this adapter will set through an agent; a human should make that change in the Google Ads UI.',
    );
  }

  if (n > ceiling) {
    throw new Error(
      `Google Ads: ${label} = ${n} exceeds this connection's ceiling of ${ceiling}. Nothing was changed. `
      + 'The ceiling is set on the connection deliberately; raising it is a decision for the account owner, '
      + 'not something to route around.',
    );
  }

  return Math.round(n * MICROS);
}

function fromMicros(micros: unknown): number | null {
  const n = Number(micros);
  return Number.isFinite(n) ? Math.round((n / MICROS) * 100) / 100 : null;
}

/**
 * A GAQL date filter for an arbitrary window.
 *
 * 🔴 NOT `DURING LAST_${days}_DAYS`. GAQL's DURING accepts only a fixed set of
 * literals — LAST_7_DAYS, LAST_14_DAYS, LAST_30_DAYS and a handful more — so
 * interpolating a number produces LAST_45_DAYS, which is a query PARSE error,
 * not a smaller result set. The failure surfaces as an unhelpful syntax
 * complaint about a query the agent never wrote.
 */
function dateRange(days: number): string {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return `segments.date BETWEEN '${iso(start)}' AND '${iso(end)}'`;
}

function cap(value: unknown): string {
  const json = JSON.stringify(value);
  return json.length <= MAX_OUTPUT
    ? json
    : `${json.slice(0, MAX_OUTPUT)}\n…truncated. Narrow the query — add a date range, a LIMIT, or fewer fields.`;
}

/** Refresh token → access token. Short-lived, so fetched per call rather than cached. */
async function accessToken(c: Creds): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: c.client_id,
        client_secret: c.client_secret,
        refresh_token: c.refresh_token,
      }).toString(),
    });
  } catch (e) {
    throw new Error(`Google Ads: could not reach Google's token endpoint — ${e instanceof Error ? e.message : String(e)}`);
  }

  const body = await resp.json().catch(() => ({})) as any;

  if (!resp.ok || !body.access_token) {
    const err = String(body?.error ?? `HTTP ${resp.status}`);
    const desc = String(body?.error_description ?? '');

    // The two that look identical in the response and are fixed differently.
    if (err === 'invalid_grant') {
      throw new Error(
        'Google Ads: the refresh token is no longer valid (invalid_grant). This happens when the token is '
        + 'revoked, the Google password changed, the OAuth consent screen is still in Testing mode (those '
        + 'tokens expire after 7 days), or the token was issued for a different client_id. A new refresh '
        + 'token has to be generated — the workspace admin does this, it is not retryable.',
      );
    }
    throw new Error(`Google Ads: token exchange failed — ${err}${desc ? `: ${desc}` : ''}`);
  }

  return String(body.access_token);
}

/** One Google Ads API call. */
async function ga(
  c: Creds,
  t: Target,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<any> {
  const token = await accessToken(c);
  const method = (init?.method ?? (init?.body === undefined ? 'GET' : 'POST')).toUpperCase();

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'developer-token': c.developer_token,
    'Content-Type': 'application/json',
  };
  if (t.loginCustomerId) {
    headers['login-customer-id'] = t.loginCustomerId;
  }

  let resp: Response;
  try {
    resp = await fetch(`${API}${path}`, {
      method,
      headers,
      signal: AbortSignal.timeout(60_000),
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (e) {
    throw new Error(`Google Ads: could not reach the API — ${e instanceof Error ? e.message : String(e)}`);
  }

  const body = await resp.json().catch(() => ({})) as any;

  if (!resp.ok) {
    const detail = body?.error ?? {};
    const inner = detail?.details?.[0]?.errors?.[0];
    const msg = String(inner?.message ?? detail?.message ?? `HTTP ${resp.status}`);
    const code = JSON.stringify(inner?.errorCode ?? {});

    /**
     * Explorer is the access level most people are granted automatically, and
     * it blocks the PLANNING services. The raw error does not say "use a
     * different product" — it says the operation is not permitted, which reads
     * like a broken connection and sends the agent off widening OAuth scopes
     * that have nothing to do with it.
     */
    if (/not permitted|developer token.*not|OPERATION_NOT_PERMITTED|planning/i.test(`${msg} ${code}`)) {
      throw new Error(
        `Google Ads: this operation is not permitted at this developer token's access level (${msg}). `
        + 'An Explorer-level token can read and mutate campaigns, keywords, budgets and bids, but CANNOT '
        + 'call the planning services — keyword ideas and search-volume forecasts. Use the Zernio '
        + 'connection for keyword discovery instead; it proxies Keyword Planner under its own token. '
        + 'This is a product boundary, not a misconfiguration.',
      );
    }
    if (resp.status === 401 || /UNAUTHENTICATED/i.test(`${msg} ${code}`)) {
      throw new Error(`Google Ads: authentication rejected (${msg}). The refresh token or client credentials are wrong.`);
    }
    if (resp.status === 403 || /USER_PERMISSION_DENIED|CUSTOMER_NOT_ENABLED/i.test(`${msg} ${code}`)) {
      throw new Error(
        `Google Ads: permission denied on customer ${t.customerId} (${msg}). The Google account behind the `
        + 'refresh token must have access to this account, and if it reaches it through a manager account '
        + 'the connection target needs loginCustomerId=<manager id>.',
      );
    }
    if (resp.status === 429 || /RESOURCE_EXHAUSTED|QUOTA/i.test(`${msg} ${code}`)) {
      throw new Error(
        `Google Ads: daily quota exhausted (${msg}). An Explorer token allows 2,880 operations per day `
        + 'against production accounts. Stop for today rather than retrying — retries consume the same quota.',
      );
    }
    throw new Error(`Google Ads ${resp.status}: ${msg}${code !== '{}' ? ` ${code}` : ''}`);
  }

  return body;
}

/** GAQL query → rows. */
async function query(c: Creds, t: Target, gaql: string, limit = 200): Promise<any[]> {
  const body = await ga(c, t, `/customers/${t.customerId}/googleAds:search`, {
    body: { query: gaql, pageSize: Math.min(Math.max(limit, 1), 1000) },
  });
  return Array.isArray(body?.results) ? body.results : [];
}

/**
 * Reject a GAQL string that is not a read.
 *
 * GAQL has no mutating verbs, so this is belt-and-braces rather than the main
 * defence — but `run_report` is the one tool with a free-text query argument,
 * and free-text arguments are where injected instructions from a client's own
 * search-terms data would land if they were ever going to land anywhere.
 */
export function assertSelectOnly(gaql: string): void {
  const q = String(gaql ?? '').trim();
  if (!q) {
    throw new Error('Google Ads: no query given.');
  }
  if (!/^select\s/i.test(q)) {
    throw new Error('Google Ads: run_report takes a GAQL SELECT. Mutations go through the dedicated tools.');
  }
}

const MATCH_TYPES = new Set(['EXACT', 'PHRASE', 'BROAD']);

const tools: BuiltinTool[] = [
  {
    name: 'account_overview',
    description: 'The state of the account: every campaign with its status, daily budget, bidding strategy, and last-30-day cost, clicks, conversions and cost per conversion. START HERE — it is one call and it tells you what is actually running and what it costs.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_terms',
    description: 'What people ACTUALLY typed to trigger the ads, with cost and conversions per term. This is where wasted spend is visible: a term with real cost and zero conversions over a meaningful window is a candidate negative keyword. Defaults to the last 30 days, most expensive first.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback window in days (default 30).' },
        min_cost: { type: 'number', description: 'Only terms costing at least this much in the window. Use it to skip the long tail of noise.' },
        zero_conversions_only: { type: 'boolean', description: 'Only terms that converted zero times — the shortlist for negatives.' },
        limit: { type: 'number', description: 'Default 100.' },
      },
    },
  },
  {
    name: 'keyword_performance',
    description: 'Per-keyword economics: match type, current max CPC, impressions, clicks, average CPC, cost, conversions and cost per conversion. Use this to find keywords whose CPC is out of line with what a conversion is worth.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback window in days (default 30).' },
        campaign: { type: 'string', description: 'Restrict to one campaign by name.' },
        limit: { type: 'number', description: 'Default 100.' },
      },
    },
  },
  {
    name: 'conversion_summary',
    description: 'Every conversion action on the account with its category, status, counting rules and recent conversion volume. Check this BEFORE drawing any conclusion about ROAS or cost per conversion — a campaign that looks like it never converts usually has a tracking problem, not a targeting problem.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'run_report',
    description: 'Run any GAQL SELECT against the account for something the purpose-built tools do not cover (geo, device, hour-of-day, ad-level, asset-level performance). Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        gaql: { type: 'string', description: 'A GAQL SELECT, e.g. "SELECT campaign.name, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS".' },
        limit: { type: 'number', description: 'Default 200, max 1000.' },
      },
      required: ['gaql'],
    },
  },
  {
    name: 'add_negative_keywords',
    description: 'Block search terms from triggering ads, at campaign level. The primary lever for cutting wasted spend, and it is additive and reversible — it can only ever reduce what the account matches. Add the terms you found with search_terms.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'From account_overview. Omit to apply to every enabled campaign.' },
        keywords: {
          type: 'array',
          description: 'Up to 50 per call.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              match_type: { type: 'string', description: 'EXACT, PHRASE or BROAD. PHRASE is the usual choice for blocking a wasteful theme; EXACT blocks only that precise query.' },
            },
            required: ['text', 'match_type'],
          },
        },
        preview: { type: 'boolean', description: 'Validate against the live account and discard. Use it once before the real call when blocking a broad theme.' },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'set_keyword_bid',
    description: 'Set the max CPC on one keyword, as a plain currency amount (2.50 means $2.50). Only has an effect under a manual or enhanced-CPC bidding strategy — under an automated strategy Google sets bids and this is ignored, so check account_overview first.',
    input_schema: {
      type: 'object',
      properties: {
        ad_group_id: { type: 'string' },
        criterion_id: { type: 'string', description: 'The keyword id, from keyword_performance.' },
        max_cpc: { type: 'number', description: 'Plain currency, e.g. 2.50. NOT micros.' },
        preview: { type: 'boolean' },
      },
      required: ['ad_group_id', 'criterion_id', 'max_cpc'],
    },
  },
  {
    name: 'set_campaign_budget',
    description: 'Set a campaign\'s DAILY budget as a plain currency amount (150 means $150/day). Google may spend up to twice this on a given day and balances it out across the month, so treat the number as a monthly average of daily spend rather than a hard daily cap.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        daily_budget: { type: 'number', description: 'Plain currency, e.g. 150. NOT micros.' },
        preview: { type: 'boolean' },
      },
      required: ['campaign_id', 'daily_budget'],
    },
  },
  {
    name: 'set_bidding_strategy',
    description: 'Change how a campaign bids. MAXIMIZE_CONVERSIONS with a target CPA is the right shape for lead generation where every form fill is worth roughly the same. TARGET_ROAS needs conversion VALUES to be tracked and enough conversion history to learn from — it will underperform on a low-volume account. Changing strategy resets Google\'s learning period; expect a week of unstable performance.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        strategy: { type: 'string', description: 'MAXIMIZE_CONVERSIONS, TARGET_CPA, TARGET_ROAS, or MANUAL_CPC.' },
        target_cpa: { type: 'number', description: 'Plain currency. For TARGET_CPA, or optionally with MAXIMIZE_CONVERSIONS.' },
        target_roas: { type: 'number', description: 'A ratio, not a percentage: 4 means $4 of conversion value per $1 spent.' },
        preview: { type: 'boolean' },
      },
      required: ['campaign_id', 'strategy'],
    },
  },
  {
    name: 'set_status',
    description: 'Pause or enable a campaign, ad group or keyword. Pausing is free and instant. ENABLING starts spending money and therefore requires confirm_spend.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', description: 'campaign, ad_group or keyword.' },
        id: { type: 'string', description: 'For a keyword, "<adGroupId>~<criterionId>".' },
        status: { type: 'string', description: 'PAUSED or ENABLED.' },
        confirm_spend: { type: 'boolean', description: 'Required for ENABLED. Tell the human the daily budget and the strategy that will start running BEFORE setting this.' },
        preview: { type: 'boolean' },
      },
      required: ['level', 'id', 'status'],
    },
  },
];

/** Shared shape for every mutate response. */
function mutateResult(a: {
  preview: boolean;
  action: string;
  detail: Record<string, unknown>;
  note?: string;
}): string {
  return cap({
    [a.preview ? 'validated' : 'applied']: true,
    action: a.action,
    ...a.detail,
    ...(a.preview
      ? { note: 'PREVIEW ONLY — Google validated this against the live account and discarded it. Nothing changed. Call again without preview to apply it.' }
      : a.note
        ? { note: a.note }
        : {}),
  });
}

export const googleAdsProvider: BuiltinProvider = {
  slug: 'google-ads',
  name: 'Google Ads',
  description: 'Read and optimise one Google Ads account — search terms and wasted spend, keyword economics, negative keywords, bids, budgets and bidding strategy. Spend ceilings are enforced by the adapter.',
  credentialLabel: 'Four lines of key=value: developer_token, client_id, client_secret, refresh_token',
  perConnection: true,
  targetLabel: 'Account — "<customerId> | maxDailyBudget=<amount> maxCpc=<amount>"',
  targetPlaceholder: '123-456-7890 | maxDailyBudget=200 maxCpc=8',
  targetIsUrl: false,

  guidance: [
    'GOOGLE ADS — division of labour. Keyword DISCOVERY (new keyword ideas, search volume, forecasts) is',
    'in Zernio, which proxies Keyword Planner under its own approved token; an Explorer-level developer',
    'token is blocked from Google\'s planning services, so do not attempt discovery here. Keyword',
    'ECONOMICS — what is being spent, on what, to what effect, and changing it — is here.',
    'Money is always a PLAIN AMOUNT in these tools: 150 means $150. Never pass micros; a value that looks',
    'like micros is refused, not converted.',
    'Before concluding anything about ROAS or cost per conversion, call conversion_summary. A campaign',
    'that appears never to convert is far more often a tracking gap than a targeting failure, and acting',
    'on the second explanation when the first is true destroys working campaigns.',
    'Order of operations for cutting waste: search_terms with zero_conversions_only to find what is being',
    'paid for and returning nothing, then add_negative_keywords. That is reversible and cannot overspend.',
    'Lowering bids and budgets comes after. Raising anything, and enabling anything paused, is a decision',
    'for the human — bring them the numbers, not a completed action.',
    'A high CPC is not automatically bad. Judge a keyword on cost per CONVERSION against what a customer',
    'is worth, never on CPC alone: an expensive click that converts often beats a cheap one that never does.',
  ].join(' '),

  tools,

  async call(tool, args, credential, target) {
    const c = parseCredential(credential);
    const t = parseTarget(target);
    const preview = args.preview === true;

    const days = Math.min(Math.max(Number(args.days) || 30, 1), 365);
    const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 1000);

    // ── Reads ───────────────────────────────────────────────────────────────

    if (tool === 'account_overview') {
      const rows = await query(c, t, `
        SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
               campaign.bidding_strategy_type, campaign_budget.amount_micros,
               campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas,
               metrics.cost_micros, metrics.clicks, metrics.impressions,
               metrics.conversions, metrics.cost_per_conversion
        FROM campaign
        WHERE segments.date DURING LAST_30_DAYS
        ORDER BY metrics.cost_micros DESC
      `, 200);

      const customer = await query(c, t, 'SELECT customer.currency_code, customer.time_zone, customer.descriptive_name FROM customer', 1);

      return cap({
        account: {
          customerId: t.customerId,
          name: customer[0]?.customer?.descriptiveName ?? null,
          currency: customer[0]?.customer?.currencyCode ?? null,
          timeZone: customer[0]?.customer?.timeZone ?? null,
        },
        ceilings: { maxDailyBudget: t.maxDailyBudget, maxCpc: t.maxCpc },
        window: 'last 30 days',
        campaigns: rows.map((r: any) => ({
          id: r.campaign?.id,
          name: r.campaign?.name,
          status: r.campaign?.status,
          channel: r.campaign?.advertisingChannelType,
          biddingStrategy: r.campaign?.biddingStrategyType,
          dailyBudget: fromMicros(r.campaignBudget?.amountMicros),
          targetCpa: fromMicros(r.campaign?.targetCpa?.targetCpaMicros),
          targetRoas: r.campaign?.targetRoas?.targetRoas ?? null,
          cost: fromMicros(r.metrics?.costMicros),
          clicks: Number(r.metrics?.clicks ?? 0),
          impressions: Number(r.metrics?.impressions ?? 0),
          conversions: Number(r.metrics?.conversions ?? 0),
          costPerConversion: fromMicros(r.metrics?.costPerConversion),
        })),
        note: 'Costs are in the account currency. A campaign showing spend with zero conversions may be a '
          + 'tracking problem — check conversion_summary before treating it as a targeting problem.',
      });
    }

    if (tool === 'search_terms') {
      const minCost = Number(args.min_cost) || 0;
      const rows = await query(c, t, `
        SELECT search_term_view.search_term, campaign.name, ad_group.name,
               metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
        FROM search_term_view
        WHERE ${dateRange(days)}
        ORDER BY metrics.cost_micros DESC
      `, limit);

      let terms = rows.map((r: any) => ({
        term: r.searchTermView?.searchTerm,
        campaign: r.campaign?.name,
        adGroup: r.adGroup?.name,
        cost: fromMicros(r.metrics?.costMicros) ?? 0,
        clicks: Number(r.metrics?.clicks ?? 0),
        impressions: Number(r.metrics?.impressions ?? 0),
        conversions: Number(r.metrics?.conversions ?? 0),
      }));

      if (args.zero_conversions_only === true) {
        terms = terms.filter(x => x.conversions === 0);
      }
      if (minCost > 0) {
        terms = terms.filter(x => x.cost >= minCost);
      }

      const wasted = terms.filter(x => x.conversions === 0).reduce((s, x) => s + x.cost, 0);

      return cap({
        window: `last ${days} days`,
        terms,
        totalSpendOnZeroConversionTerms: Math.round(wasted * 100) / 100,
        note: 'A term with zero conversions is only evidence once it has had enough clicks to have shown '
          + 'one — a single click proves nothing. Weigh clicks, not just cost, before adding a negative.',
      });
    }

    if (tool === 'keyword_performance') {
      const campaign = String(args.campaign ?? '').trim();
      const rows = await query(c, t, `
        SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
               ad_group_criterion.keyword.match_type, ad_group_criterion.status,
               ad_group_criterion.effective_cpc_bid_micros, ad_group.id, ad_group.name, campaign.name,
               metrics.impressions, metrics.clicks, metrics.average_cpc,
               metrics.cost_micros, metrics.conversions, metrics.cost_per_conversion
        FROM keyword_view
        WHERE ${dateRange(days)}
          AND ad_group_criterion.status != 'REMOVED'
          ${campaign ? `AND campaign.name = '${campaign.replace(/'/g, '')}'` : ''}
        ORDER BY metrics.cost_micros DESC
      `, limit);

      return cap({
        window: `last ${days} days`,
        keywords: rows.map((r: any) => ({
          criterionId: r.adGroupCriterion?.criterionId,
          adGroupId: r.adGroup?.id,
          adGroup: r.adGroup?.name,
          campaign: r.campaign?.name,
          keyword: r.adGroupCriterion?.keyword?.text,
          matchType: r.adGroupCriterion?.keyword?.matchType,
          status: r.adGroupCriterion?.status,
          currentMaxCpc: fromMicros(r.adGroupCriterion?.effectiveCpcBidMicros),
          impressions: Number(r.metrics?.impressions ?? 0),
          clicks: Number(r.metrics?.clicks ?? 0),
          averageCpc: fromMicros(r.metrics?.averageCpc),
          cost: fromMicros(r.metrics?.costMicros),
          conversions: Number(r.metrics?.conversions ?? 0),
          costPerConversion: fromMicros(r.metrics?.costPerConversion),
        })),
      });
    }

    if (tool === 'conversion_summary') {
      const actions = await query(c, t, `
        SELECT conversion_action.id, conversion_action.name, conversion_action.status,
               conversion_action.type, conversion_action.category,
               conversion_action.primary_for_goal, conversion_action.counting_type,
               conversion_action.value_settings.default_value
        FROM conversion_action
      `, 200);

      const recent = await query(c, t, `
        SELECT segments.conversion_action_name, metrics.all_conversions, metrics.all_conversions_value
        FROM customer
        WHERE segments.date DURING LAST_30_DAYS
      `, 200);

      return cap({
        conversionActions: actions.map((r: any) => ({
          id: r.conversionAction?.id,
          name: r.conversionAction?.name,
          status: r.conversionAction?.status,
          type: r.conversionAction?.type,
          category: r.conversionAction?.category,
          primaryForGoal: r.conversionAction?.primaryForGoal,
          countingType: r.conversionAction?.countingType,
          defaultValue: r.conversionAction?.valueSettings?.defaultValue ?? null,
        })),
        last30Days: recent.map((r: any) => ({
          action: r.segments?.conversionActionName,
          conversions: Number(r.metrics?.allConversions ?? 0),
          value: Number(r.metrics?.allConversionsValue ?? 0),
        })),
        note: 'TARGET_ROAS is only meaningful if conversions carry VALUES — if every conversion value is 0 '
          + 'or absent, ROAS cannot be computed and a target ROAS strategy has nothing to optimise against. '
          + 'For lead generation, cost per conversion against what a customer is worth is the honest measure.',
      });
    }

    if (tool === 'run_report') {
      const gaql = String(args.gaql ?? '');
      assertSelectOnly(gaql);
      const rows = await query(c, t, gaql, Number(args.limit) || 200);
      return cap({ rowCount: rows.length, rows });
    }

    // ── Writes ──────────────────────────────────────────────────────────────

    if (tool === 'add_negative_keywords') {
      const list = Array.isArray(args.keywords) ? args.keywords : [];
      if (list.length === 0) {
        throw new Error('Google Ads: no keywords given.');
      }
      if (list.length > 50) {
        throw new Error(`Google Ads: ${list.length} negatives in one call is too many to review. Send at most 50.`);
      }

      for (const k of list) {
        const mt = String((k as any)?.match_type ?? '').toUpperCase();
        if (!MATCH_TYPES.has(mt)) {
          throw new Error(`Google Ads: match_type must be EXACT, PHRASE or BROAD — got "${(k as any)?.match_type}".`);
        }
        if (!String((k as any)?.text ?? '').trim()) {
          throw new Error('Google Ads: a negative keyword has empty text.');
        }
      }

      let campaignIds: string[];
      if (args.campaign_id) {
        campaignIds = [digits(args.campaign_id)];
      } else {
        const rows = await query(c, t, 'SELECT campaign.id FROM campaign WHERE campaign.status = \'ENABLED\'', 200);
        campaignIds = rows.map((r: any) => String(r.campaign?.id)).filter(Boolean);
        if (campaignIds.length === 0) {
          throw new Error('Google Ads: no enabled campaigns to add negatives to. Pass campaign_id explicitly if you meant a paused one.');
        }
      }

      const operations = campaignIds.flatMap(cid => list.map((k: any) => ({
        create: {
          campaign: `customers/${t.customerId}/campaigns/${cid}`,
          negative: true,
          keyword: { text: String(k.text).trim(), matchType: String(k.match_type).toUpperCase() },
        },
      })));

      const body = await ga(c, t, `/customers/${t.customerId}/campaignCriteria:mutate`, {
        body: { operations, validateOnly: preview, partialFailure: false },
      });

      return mutateResult({
        preview,
        action: 'add_negative_keywords',
        detail: {
          campaigns: campaignIds,
          added: list.map((k: any) => `${String(k.match_type).toUpperCase()}: ${k.text}`),
          count: operations.length,
          results: preview ? undefined : (body?.results?.length ?? 0),
        },
        note: 'Negatives take effect on the next auction. They only ever REDUCE matching, so this cannot '
          + 'increase spend — but an over-broad PHRASE negative can silence a working keyword. Re-check '
          + 'search_terms in a few days.',
      });
    }

    if (tool === 'set_keyword_bid') {
      const adGroupId = digits(args.ad_group_id);
      const criterionId = digits(args.criterion_id);
      if (!adGroupId || !criterionId) {
        throw new Error('Google Ads: ad_group_id and criterion_id are required (both from keyword_performance).');
      }

      const micros = toMicros(args.max_cpc, 'max_cpc', t.maxCpc);

      const body = await ga(c, t, `/customers/${t.customerId}/adGroupCriteria:mutate`, {
        body: {
          operations: [{
            update: {
              resourceName: `customers/${t.customerId}/adGroupCriteria/${adGroupId}~${criterionId}`,
              cpcBidMicros: String(micros),
            },
            updateMask: 'cpcBidMicros',
          }],
          validateOnly: preview,
        },
      });

      return mutateResult({
        preview,
        action: 'set_keyword_bid',
        detail: { adGroupId, criterionId, maxCpc: Number(args.max_cpc), resourceName: body?.results?.[0]?.resourceName ?? null },
        note: 'Under an automated bidding strategy Google overrides this. Confirm the campaign is on MANUAL_CPC '
          + 'before treating the change as effective.',
      });
    }

    if (tool === 'set_campaign_budget') {
      const campaignId = digits(args.campaign_id);
      if (!campaignId) {
        throw new Error('Google Ads: campaign_id is required.');
      }

      const micros = toMicros(args.daily_budget, 'daily_budget', t.maxDailyBudget);

      // Read the budget resource AND the current amount — an approval that
      // cannot show what the budget is now is not reviewable.
      const rows = await query(c, t, `
        SELECT campaign.name, campaign_budget.resource_name, campaign_budget.amount_micros
        FROM campaign WHERE campaign.id = ${campaignId}
      `, 1);
      const budgetResource = rows[0]?.campaignBudget?.resourceName;
      if (!budgetResource) {
        throw new Error(`Google Ads: no campaign with id ${campaignId} on customer ${t.customerId}.`);
      }
      const previous = fromMicros(rows[0]?.campaignBudget?.amountMicros);

      const body = await ga(c, t, `/customers/${t.customerId}/campaignBudgets:mutate`, {
        body: {
          operations: [{
            update: { resourceName: budgetResource, amountMicros: String(micros) },
            updateMask: 'amountMicros',
          }],
          validateOnly: preview,
        },
      });

      return mutateResult({
        preview,
        action: 'set_campaign_budget',
        detail: {
          campaign: rows[0]?.campaign?.name,
          campaignId,
          previousDailyBudget: previous,
          newDailyBudget: Number(args.daily_budget),
          resourceName: body?.results?.[0]?.resourceName ?? budgetResource,
        },
        note: 'Google can spend up to 2× the daily budget on any single day, averaging out across the month. '
          + 'A budget shared by several campaigns changes all of them.',
      });
    }

    if (tool === 'set_bidding_strategy') {
      const campaignId = digits(args.campaign_id);
      const strategy = String(args.strategy ?? '').toUpperCase();
      if (!campaignId) {
        throw new Error('Google Ads: campaign_id is required.');
      }

      const update: Record<string, unknown> = { resourceName: `customers/${t.customerId}/campaigns/${campaignId}` };
      const masks: string[] = [];

      if (strategy === 'MANUAL_CPC') {
        update.manualCpc = { enhancedCpcEnabled: false };
        masks.push('manual_cpc');
      } else if (strategy === 'MAXIMIZE_CONVERSIONS') {
        const mc: Record<string, unknown> = {};
        if (args.target_cpa !== undefined) {
          mc.targetCpaMicros = String(toMicros(args.target_cpa, 'target_cpa', t.maxDailyBudget));
        }
        update.maximizeConversions = mc;
        masks.push('maximize_conversions');
      } else if (strategy === 'TARGET_CPA') {
        if (args.target_cpa === undefined) {
          throw new Error('Google Ads: TARGET_CPA needs target_cpa — the amount you are willing to pay for one conversion.');
        }
        update.targetCpa = { targetCpaMicros: String(toMicros(args.target_cpa, 'target_cpa', t.maxDailyBudget)) };
        masks.push('target_cpa');
      } else if (strategy === 'TARGET_ROAS') {
        const roas = Number(args.target_roas);
        if (!Number.isFinite(roas) || roas <= 0) {
          throw new Error('Google Ads: TARGET_ROAS needs target_roas as a ratio — 4 means $4 of conversion value per $1 spent.');
        }
        /**
         * A target ROAS above ~50 is nearly always a percentage that was meant
         * to be a ratio (400 for 400%). Google would accept it and then simply
         * stop bidding, because no auction clears that bar — the campaign goes
         * quiet and looks broken rather than misconfigured.
         */
        if (roas > 50) {
          throw new Error(
            `Google Ads: target_roas = ${roas} is a RATIO, not a percentage — 4 means 400%. A value this high `
            + 'would stop the campaign serving entirely. Nothing was changed.',
          );
        }
        update.targetRoas = { targetRoas: roas };
        masks.push('target_roas');
      } else {
        throw new Error(`Google Ads: strategy must be MAXIMIZE_CONVERSIONS, TARGET_CPA, TARGET_ROAS or MANUAL_CPC — got "${args.strategy}".`);
      }

      const body = await ga(c, t, `/customers/${t.customerId}/campaigns:mutate`, {
        body: { operations: [{ update, updateMask: masks.join(',') }], validateOnly: preview },
      });

      return mutateResult({
        preview,
        action: 'set_bidding_strategy',
        detail: {
          campaignId,
          strategy,
          targetCpa: args.target_cpa ?? null,
          targetRoas: args.target_roas ?? null,
          resourceName: body?.results?.[0]?.resourceName ?? null,
        },
        note: 'Changing strategy restarts Google\'s learning period. Performance is unreliable for roughly a '
          + 'week and judging the change before then will mislead you — do not revert it on day two.',
      });
    }

    if (tool === 'set_status') {
      const level = String(args.level ?? '').toLowerCase();
      const status = String(args.status ?? '').toUpperCase();
      const id = String(args.id ?? '').trim();

      if (status !== 'PAUSED' && status !== 'ENABLED') {
        throw new Error(`Google Ads: status must be PAUSED or ENABLED — got "${args.status}".`);
      }
      if (!id) {
        throw new Error('Google Ads: id is required.');
      }

      /**
       * 🔴 The asymmetry is the point. Pausing costs nothing and can be undone;
       * enabling starts an auction that spends real money, possibly overnight
       * while nobody is watching. This account in particular is deliberately
       * paused, so an agent "helpfully" resuming it is the single most
       * expensive mistake available here.
       */
      if (status === 'ENABLED' && args.confirm_spend !== true) {
        throw new Error(
          `Google Ads: enabling this ${level} will START SPENDING. Nothing was changed. First tell the human `
          + 'what the daily budget and bidding strategy are (from account_overview), so they know the rate at '
          + 'which money will leave, then call again with confirm_spend: true.',
        );
      }

      let path: string;
      let resourceName: string;
      if (level === 'campaign') {
        path = 'campaigns';
        resourceName = `customers/${t.customerId}/campaigns/${digits(id)}`;
      } else if (level === 'ad_group') {
        path = 'adGroups';
        resourceName = `customers/${t.customerId}/adGroups/${digits(id)}`;
      } else if (level === 'keyword') {
        const [ag, crit] = id.split('~');
        if (!ag || !crit) {
          throw new Error('Google Ads: for a keyword, id must be "<adGroupId>~<criterionId>".');
        }
        path = 'adGroupCriteria';
        resourceName = `customers/${t.customerId}/adGroupCriteria/${digits(ag)}~${digits(crit)}`;
      } else {
        throw new Error(`Google Ads: level must be campaign, ad_group or keyword — got "${args.level}".`);
      }

      const body = await ga(c, t, `/customers/${t.customerId}/${path}:mutate`, {
        body: {
          operations: [{ update: { resourceName, status }, updateMask: 'status' }],
          validateOnly: preview,
        },
      });

      return mutateResult({
        preview,
        action: 'set_status',
        detail: { level, id, status, resourceName: body?.results?.[0]?.resourceName ?? resourceName },
        note: status === 'ENABLED'
          ? 'This is now live and spending. Check cost tomorrow rather than at the end of the week.'
          : 'Paused. Spend stops within minutes; already-running auctions may still bill.',
      });
    }

    throw new Error(`Unknown Google Ads tool: ${tool}`);
  },
};
