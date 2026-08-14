/**
 * Google Ads — the refusals.
 *
 * This adapter is the only one in the platform whose mistakes cost money in
 * real time. Every test here stands for a specific way a live account at
 * $150/day gets damaged, and most of them are quiet failures: the account keeps
 * working, the tool reports success, and the damage shows up on an invoice or
 * in a week of missing traffic.
 *
 * The approvals gateway does not help with these. A human reading
 * `amountMicros: 150000000` cannot tell whether it is right.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSelectOnly, googleAdsProvider, toMicros } from '@/libs/plugins/googleAds';

const CRED = [
  'developer_token=devtok',
  'client_id=cid',
  'client_secret=secret',
  'refresh_token=rtok',
].join('\n');

const TARGET = '123-456-7890 | maxDailyBudget=200 maxCpc=8';

type Call = { url: string; method: string; body?: any };

function stubGoogle(rows: any[] = []) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const u = String(url);
    const method = String(init?.method ?? 'GET').toUpperCase();

    if (u.includes('oauth2')) {
      calls.push({ url: u, method, body: 'token-exchange' });
      return new Response(JSON.stringify({ access_token: 'at-123' }), { status: 200 });
    }

    calls.push({ url: u, method, body: init?.body ? JSON.parse(init.body) : undefined });

    if (u.includes(':search')) {
      return new Response(JSON.stringify({ results: rows }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [{ resourceName: 'customers/1234567890/x/1' }] }), { status: 200 });
  }));
  return calls;
}

const mutates = (calls: Call[]) => calls.filter(c => c.url.includes(':mutate'));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('micros — the unit that empties an account', () => {
  it('converts a plain amount', () => {
    expect(toMicros(150, 'daily_budget', 200)).toBe(150_000_000);
    expect(toMicros(2.5, 'max_cpc', 8)).toBe(2_500_000);
  });

  /**
   * The catastrophic direction. 150000000 is an ordinary micros value and a
   * $150,000,000 daily budget. Google accepts it either way, so the adapter has
   * to refuse rather than guess which the caller meant.
   */
  it('refuses a value that is already micros instead of converting it', () => {
    expect(() => toMicros(150_000_000, 'daily_budget', 200)).toThrow(/looks like MICROS/);
  });

  it('refuses an amount above the connection ceiling', () => {
    expect(() => toMicros(500, 'daily_budget', 200)).toThrow(/exceeds this connection's ceiling of 200/);
    expect(() => toMicros(25, 'max_cpc', 8)).toThrow(/ceiling of 8/);
  });

  it('refuses zero, negative and non-numeric amounts', () => {
    expect(() => toMicros(0, 'max_cpc', 8)).toThrow(/positive amount/);
    expect(() => toMicros(-5, 'max_cpc', 8)).toThrow(/positive amount/);
    expect(() => toMicros('lots', 'max_cpc', 8)).toThrow(/positive amount/);
  });
});

describe('spend ceilings are enforced before any request', () => {
  it('refuses an over-ceiling budget without contacting Google', async () => {
    const calls = stubGoogle();

    await expect(googleAdsProvider.call(
      'set_campaign_budget',
      { campaign_id: '999', daily_budget: 5000 },
      CRED,
      TARGET,
    )).rejects.toThrow(/ceiling of 200/);

    expect(mutates(calls)).toHaveLength(0);
  });

  it('refuses an over-ceiling keyword bid', async () => {
    const calls = stubGoogle();

    await expect(googleAdsProvider.call(
      'set_keyword_bid',
      { ad_group_id: '1', criterion_id: '2', max_cpc: 30 },
      CRED,
      TARGET,
    )).rejects.toThrow(/ceiling of 8/);

    expect(mutates(calls)).toHaveLength(0);
  });

  // A connection with no declared ceiling would be an adapter with no upper
  // bound on spend, so it must not be usable at all.
  it('refuses to operate when the connection declares no ceilings', async () => {
    stubGoogle();

    await expect(googleAdsProvider.call('account_overview', {}, CRED, '1234567890'))
      .rejects
      .toThrow(/must declare spend ceilings/);
  });
});

describe('turning spend on', () => {
  /**
   * Sonia's account is deliberately paused. An agent resuming it is the single
   * most expensive mistake available here, and it is exactly the kind of
   * "helpful" step an agent takes on its own.
   */
  it('refuses to enable anything without explicit confirmation', async () => {
    const calls = stubGoogle();

    await expect(googleAdsProvider.call(
      'set_status',
      { level: 'campaign', id: '555', status: 'ENABLED' },
      CRED,
      TARGET,
    )).rejects.toThrow(/will START SPENDING/);

    expect(mutates(calls)).toHaveLength(0);
  });

  it('enables once confirmed', async () => {
    const calls = stubGoogle();

    const out = JSON.parse(await googleAdsProvider.call(
      'set_status',
      { level: 'campaign', id: '555', status: 'ENABLED', confirm_spend: true },
      CRED,
      TARGET,
    ) as string);

    expect(out.applied).toBe(true);
    expect(mutates(calls)[0]!.body.operations[0].update.status).toBe('ENABLED');
  });

  // Pausing is free and reversible, so gating it would only train the agent to
  // set confirmation flags reflexively.
  it('pauses without any confirmation', async () => {
    const calls = stubGoogle();

    await googleAdsProvider.call(
      'set_status',
      { level: 'campaign', id: '555', status: 'PAUSED' },
      CRED,
      TARGET,
    );

    expect(mutates(calls)[0]!.body.operations[0].update.status).toBe('PAUSED');
  });
});

describe('bidding strategy', () => {
  /**
   * 400 meaning "400%" is the natural way to say it and the API accepts it as a
   * ratio. The campaign then stops serving, because no auction returns 400x.
   * It looks broken rather than misconfigured.
   */
  it('refuses a target ROAS that is really a percentage', async () => {
    const calls = stubGoogle();

    await expect(googleAdsProvider.call(
      'set_bidding_strategy',
      { campaign_id: '1', strategy: 'TARGET_ROAS', target_roas: 400 },
      CRED,
      TARGET,
    )).rejects.toThrow(/RATIO, not a percentage/);

    expect(mutates(calls)).toHaveLength(0);
  });

  it('accepts a sane ratio', async () => {
    const calls = stubGoogle();

    await googleAdsProvider.call(
      'set_bidding_strategy',
      { campaign_id: '1', strategy: 'TARGET_ROAS', target_roas: 4 },
      CRED,
      TARGET,
    );

    expect(mutates(calls)[0]!.body.operations[0].update.targetRoas.targetRoas).toBe(4);
  });

  it('refuses TARGET_CPA with no target', async () => {
    stubGoogle();

    await expect(googleAdsProvider.call(
      'set_bidding_strategy',
      { campaign_id: '1', strategy: 'TARGET_CPA' },
      CRED,
      TARGET,
    )).rejects.toThrow(/needs target_cpa/);
  });

  it('warns that the change restarts the learning period', async () => {
    stubGoogle();

    const out = JSON.parse(await googleAdsProvider.call(
      'set_bidding_strategy',
      { campaign_id: '1', strategy: 'MAXIMIZE_CONVERSIONS', target_cpa: 60 },
      CRED,
      TARGET,
    ) as string);

    expect(out.note).toMatch(/learning period/);
  });
});

describe('negative keywords', () => {
  it('adds them to the named campaign', async () => {
    const calls = stubGoogle();

    await googleAdsProvider.call(
      'add_negative_keywords',
      { campaign_id: '77', keywords: [{ text: 'free therapy', match_type: 'PHRASE' }] },
      CRED,
      TARGET,
    );

    const op = mutates(calls)[0]!.body.operations[0].create;

    expect(op.negative).toBe(true);
    expect(op.keyword).toEqual({ text: 'free therapy', matchType: 'PHRASE' });
    expect(op.campaign).toBe('customers/1234567890/campaigns/77');
  });

  it('refuses an invalid match type rather than defaulting to one', async () => {
    const calls = stubGoogle();

    await expect(googleAdsProvider.call(
      'add_negative_keywords',
      { campaign_id: '77', keywords: [{ text: 'x', match_type: 'CLOSE_ENOUGH' }] },
      CRED,
      TARGET,
    )).rejects.toThrow(/EXACT, PHRASE or BROAD/);

    expect(mutates(calls)).toHaveLength(0);
  });

  // 50 negatives is already more than anyone reviews properly; hundreds in one
  // approval is a rubber stamp.
  it('caps how many can be added in one reviewable call', async () => {
    stubGoogle();

    await expect(googleAdsProvider.call(
      'add_negative_keywords',
      { keywords: Array.from({ length: 51 }, (_, i) => ({ text: `k${i}`, match_type: 'EXACT' })) },
      CRED,
      TARGET,
    )).rejects.toThrow(/at most 50/);
  });
});

describe('preview', () => {
  it('asks Google to validate and discard, and says so', async () => {
    const calls = stubGoogle();

    const out = JSON.parse(await googleAdsProvider.call(
      'add_negative_keywords',
      { campaign_id: '77', keywords: [{ text: 'x', match_type: 'EXACT' }], preview: true },
      CRED,
      TARGET,
    ) as string);

    expect(mutates(calls)[0]!.body.validateOnly).toBe(true);
    expect(out.validated).toBe(true);
    expect(out.applied).toBeUndefined();
    expect(out.note).toMatch(/Nothing changed/);
  });
});

describe('the account is the connection, not an argument', () => {
  it('always targets the connection customer id', async () => {
    const calls = stubGoogle([{
      campaign: { name: 'Search' },
      campaignBudget: { resourceName: 'customers/1234567890/campaignBudgets/5', amountMicros: '100000000' },
    }]);

    await googleAdsProvider.call(
      'set_campaign_budget',
      { campaign_id: '1', daily_budget: 150, customer_id: '9999999999' },
      CRED,
      TARGET,
    );

    for (const c of calls.filter(x => !x.url.includes('oauth2'))) {
      expect(c.url).toContain('/customers/1234567890/');
      expect(c.url).not.toContain('9999999999');
    }
  });

  it('accepts a hyphenated customer id and strips it for the API', async () => {
    const calls = stubGoogle();

    await googleAdsProvider.call('account_overview', {}, CRED, TARGET);

    expect(calls.find(c => c.url.includes(':search'))!.url).toContain('/customers/1234567890/');
  });

  it('rejects a customer id that is not ten digits', async () => {
    stubGoogle();

    await expect(googleAdsProvider.call('account_overview', {}, CRED, '12345 | maxDailyBudget=200 maxCpc=8'))
      .rejects
      .toThrow(/not a 10-digit customer id/);
  });
});

describe('credentials', () => {
  it('names exactly which keys are missing', async () => {
    stubGoogle();

    await expect(googleAdsProvider.call('account_overview', {}, 'developer_token=x\nclient_id=y', TARGET))
      .rejects
      .toThrow(/missing client_secret, refresh_token/);
  });

  /**
   * invalid_grant is the most common Google Ads failure and the least
   * self-explanatory — the usual cause is an OAuth consent screen left in
   * Testing mode, which silently expires refresh tokens after seven days.
   */
  it('explains invalid_grant instead of echoing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      { status: 400 },
    )));

    await expect(googleAdsProvider.call('account_overview', {}, CRED, TARGET))
      .rejects
      .toThrow(/Testing mode/);
  });
});

describe('errors that point at the wrong fix', () => {
  /**
   * The Explorer access level blocks the PLANNING services. The raw error reads
   * like a permissions problem, which sends the agent off widening OAuth scopes
   * that were never involved — the Cloudflare failure again, in a new costume.
   */
  it('reads a planning-service refusal as a product boundary, and names Zernio', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('oauth2')) {
        return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        error: { message: 'The developer token is not permitted to access this service.' },
      }), { status: 403 });
    }));

    await expect(googleAdsProvider.call('account_overview', {}, CRED, TARGET))
      .rejects
      .toThrow(/Zernio connection for keyword discovery/);
  });

  it('tells the agent to stop rather than retry when quota is gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('oauth2')) {
        return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'Resource has been exhausted' } }), { status: 429 });
    }));

    await expect(googleAdsProvider.call('account_overview', {}, CRED, TARGET))
      .rejects
      .toThrow(/Stop for today rather than retrying/);
  });
});

describe('reads', () => {
  it('run_report refuses anything that is not a SELECT', () => {
    expect(() => assertSelectOnly('SELECT campaign.id FROM campaign')).not.toThrow();
    expect(() => assertSelectOnly('DELETE FROM campaign')).toThrow(/takes a GAQL SELECT/);
    expect(() => assertSelectOnly('  ')).toThrow(/no query/);
  });

  /**
   * GAQL's DURING takes fixed literals only, so LAST_45_DAYS is a parse error
   * rather than a 45-day window — the query has to use an explicit range.
   */
  it('uses an explicit date range for a non-standard window', async () => {
    const calls = stubGoogle();

    await googleAdsProvider.call('search_terms', { days: 45 }, CRED, TARGET);

    const q = calls.find(c => c.url.includes(':search'))!.body.query;

    expect(q).toMatch(/segments\.date BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'/);
    expect(q).not.toContain('LAST_45_DAYS');
  });

  it('totals what was spent on terms that never converted', async () => {
    stubGoogle([
      { searchTermView: { searchTerm: 'free counselling' }, metrics: { costMicros: '40000000', clicks: 12, conversions: 0 } },
      { searchTermView: { searchTerm: 'therapist near me' }, metrics: { costMicros: '30000000', clicks: 9, conversions: 2 } },
    ]);

    const out = JSON.parse(await googleAdsProvider.call(
      'search_terms',
      { zero_conversions_only: true },
      CRED,
      TARGET,
    ) as string);

    expect(out.terms).toHaveLength(1);
    expect(out.terms[0].term).toBe('free counselling');
    expect(out.totalSpendOnZeroConversionTerms).toBe(40);
  });

  // Cost per conversion is meaningless if nothing is tracked, and "this campaign
  // never converts" is far more often a tracking gap than a targeting failure.
  it('warns that ROAS needs conversion values', async () => {
    stubGoogle([]);

    const out = JSON.parse(await googleAdsProvider.call('conversion_summary', {}, CRED, TARGET) as string);

    expect(out.note).toMatch(/conversions carry VALUES/);
  });
});
