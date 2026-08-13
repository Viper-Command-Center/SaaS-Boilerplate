/**
 * Cloudflare DNS — the guardrails, not the happy path.
 *
 * Every test here stands for a specific way a client's site or email goes down.
 * The approvals gateway is not enough on its own: approval fatigue is real, and
 * a human clicking through a change they do not fully understand is the normal
 * case. So the refusals live in the adapter, and these prove they hold.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudflareDnsProvider } from '@/libs/plugins/cloudflareDns';

const TOKEN = 'cf-token';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Zone lookup, then whatever the tool asks for. */
function stubCf(opts?: { record?: any; onWrite?: (url: string, method: string) => Response }) {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const u = String(url);
    const method = String(init?.method ?? 'GET').toUpperCase();
    calls.push({ url: u, method, body: init?.body ? JSON.parse(init.body) : undefined });

    if (u.includes('/zones?name=')) {
      return new Response(JSON.stringify({
        success: true,
        result: [{ id: 'zone1', name: 'examplechurch.org' }],
      }), { status: 200 });
    }
    if (u.includes('/dns_records/') && method === 'GET') {
      return new Response(JSON.stringify({
        success: true,
        result: opts?.record ?? { id: 'rec1', type: 'A', name: 'examplechurch.org', content: '203.0.113.10', ttl: 1 },
      }), { status: 200 });
    }
    if (u.includes('/dns_records?') && method === 'GET') {
      return new Response(JSON.stringify({
        success: true,
        result: [opts?.record ?? { id: 'rec1', type: 'A', name: 'examplechurch.org', content: '203.0.113.10', ttl: 1 }],
      }), { status: 200 });
    }
    if (method !== 'GET' && opts?.onWrite) {
      return opts.onWrite(u, method);
    }
    return new Response(JSON.stringify({
      success: true,
      result: opts?.record ?? { id: 'rec1', type: 'A', name: 'examplechurch.org', content: '198.51.100.5', ttl: 1 },
    }), { status: 200 });
  }));
  return calls;
}

describe('protected record types', () => {
  /**
   * Rewriting NS delegates the whole domain elsewhere. It is refused rather
   * than gated behind a confirmation, because a confirmation only proves a
   * boolean was set, not that anyone understood the consequence.
   */
  it('refuses to create an NS record', async () => {
    stubCf();

    await expect(cloudflareDnsProvider.call(
      'create_record',
      { domain: 'examplechurch.org', type: 'NS', name: '@', content: 'ns1.evil.com' },
      TOKEN,
    )).rejects.toThrow(/cannot be created/);
  });

  it('refuses to create an SOA record', async () => {
    stubCf();

    await expect(cloudflareDnsProvider.call(
      'create_record',
      { domain: 'examplechurch.org', type: 'soa', name: '@', content: 'x' },
      TOKEN,
    )).rejects.toThrow(/cannot be created/);
  });

  // The type is discovered by READING the record first — the caller never
  // declares it, so it cannot be lied about.
  it('refuses to update a record that turns out to be NS', async () => {
    stubCf({ record: { id: 'rec1', type: 'NS', name: 'examplechurch.org', content: 'ns1.cloudflare.com' } });

    await expect(cloudflareDnsProvider.call(
      'update_record',
      { domain: 'examplechurch.org', record_id: 'rec1', content: 'ns1.evil.com' },
      TOKEN,
    )).rejects.toThrow(/will not change it/);
  });

  it('refuses to delete an NS record even with confirmation set', async () => {
    stubCf({ record: { id: 'rec1', type: 'NS', name: 'examplechurch.org', content: 'ns1.cloudflare.com' } });

    await expect(cloudflareDnsProvider.call(
      'delete_record',
      { domain: 'examplechurch.org', record_id: 'rec1', confirm_destructive: true },
      TOKEN,
    )).rejects.toThrow(/cannot be deleted/);
  });
});

describe('deletion', () => {
  it('refuses without confirmation, and names the value being destroyed', async () => {
    const calls = stubCf();

    await expect(cloudflareDnsProvider.call(
      'delete_record',
      { domain: 'examplechurch.org', record_id: 'rec1' },
      TOKEN,
    )).rejects.toThrow(/203\.0\.113\.10/);

    // Nothing was deleted while it complained.
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
  });

  it('deletes once confirmed, and reports what went', async () => {
    const calls = stubCf();

    const out = JSON.parse(await cloudflareDnsProvider.call(
      'delete_record',
      { domain: 'examplechurch.org', record_id: 'rec1', confirm_destructive: true },
      TOKEN,
    ) as string);

    expect(calls.some(c => c.method === 'DELETE')).toBe(true);
    expect(out.record.content).toBe('203.0.113.10');
    expect(out.note).toMatch(/verify the site and email/);
  });
});

describe('updates', () => {
  // An approval that cannot show the old value is not reviewable.
  it('reports the previous value alongside the new one', async () => {
    stubCf();

    const out = JSON.parse(await cloudflareDnsProvider.call(
      'update_record',
      { domain: 'examplechurch.org', record_id: 'rec1', content: '198.51.100.5' },
      TOKEN,
    ) as string);

    expect(out.previous.content).toBe('203.0.113.10');
    expect(out.now.content).toBe('198.51.100.5');
  });

  it('refuses an update that would change nothing', async () => {
    stubCf();

    await expect(cloudflareDnsProvider.call(
      'update_record',
      { domain: 'examplechurch.org', record_id: 'rec1' },
      TOKEN,
    )).rejects.toThrow(/nothing to update/);
  });
});

describe('impact flagging', () => {
  it('warns that an MX record is email', async () => {
    stubCf({ record: { id: 'r', type: 'MX', name: 'examplechurch.org', content: 'mail.x.com', ttl: 1 } });

    const out = JSON.parse(await cloudflareDnsProvider.call(
      'create_record',
      { domain: 'examplechurch.org', type: 'MX', name: '@', content: 'mail.x.com', priority: 10 },
      TOKEN,
    ) as string);

    expect(out.note).toMatch(/EMAIL/);
  });

  it('warns that the zone apex is the whole website', async () => {
    stubCf({ record: { id: 'r', type: 'A', name: 'examplechurch.org', content: '1.2.3.4', ttl: 1 } });

    const out = JSON.parse(await cloudflareDnsProvider.call(
      'create_record',
      { domain: 'examplechurch.org', type: 'A', name: '@', content: '1.2.3.4' },
      TOKEN,
    ) as string);

    expect(out.note).toMatch(/whole site offline/);
  });
});

describe('request shaping', () => {
  // Cloudflare rejects `proxied` on types that cannot be proxied, and the error
  // reads like a permissions problem.
  it('only sends proxied for record types that support it', async () => {
    const calls = stubCf({ record: { id: 'r', type: 'MX', name: 'x', content: 'y', ttl: 1 } });

    await cloudflareDnsProvider.call(
      'create_record',
      { domain: 'examplechurch.org', type: 'MX', name: '@', content: 'mail.x.com', proxied: true },
      TOKEN,
    );

    const post = calls.find(c => c.method === 'POST');

    expect(post!.body).not.toHaveProperty('proxied');
  });

  it('sends proxied for A records', async () => {
    const calls = stubCf();

    await cloudflareDnsProvider.call(
      'create_record',
      { domain: 'examplechurch.org', type: 'A', name: '@', content: '1.2.3.4', proxied: true },
      TOKEN,
    );

    expect(calls.find(c => c.method === 'POST')!.body.proxied).toBe(true);
  });

  it('strips a Bearer prefix from the token', async () => {
    const calls = stubCf();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      calls.push({ url: String(url), method: 'GET', body: init?.headers });
      return new Response(JSON.stringify({ success: true, result: [{ id: 'z', name: 'x.org' }] }), { status: 200 });
    }));

    await cloudflareDnsProvider.call('list_zones', {}, 'Bearer cf-token');

    expect((calls.at(-1)!.body as any).Authorization).toBe('Bearer cf-token');
  });
});

describe('errors', () => {
  it('explains a missing token permission rather than echoing the code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ success: false, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }] }),
      { status: 403 },
    )));

    await expect(cloudflareDnsProvider.call('list_zones', {}, TOKEN))
      .rejects
      .toThrow(/Zone → DNS → Edit/);
  });

  /**
   * The failure that cost a real debugging session: an OAuth scope error from
   * Cloudflare's hosted MCP server, mistaken for a token-permission problem and
   * chased by repeatedly widening an API token that was never consulted.
   */
  it('recognises an OAuth scope error as the wrong connection type entirely', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ success: false, errors: [{ code: 0, message: 'insufficient_scope: Token lacks required user:read scope' }] }),
      { status: 403 },
    )));

    await expect(cloudflareDnsProvider.call('list_zones', {}, TOKEN))
      .rejects
      .toThrow(/hosted MCP server/);
  });

  it('says plainly when a domain is not on this token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ success: true, result: [] }),
      { status: 200 },
    )));

    await expect(cloudflareDnsProvider.call('list_records', { domain: 'notmine.org' }, TOKEN))
      .rejects
      .toThrow(/no zone called "notmine.org"/);
  });

  it('accepts a domain pasted as a URL', async () => {
    const calls = stubCf();

    await cloudflareDnsProvider.call('list_records', { domain: 'https://examplechurch.org/about' }, TOKEN);

    expect(calls[0]!.url).toContain('name=examplechurch.org');
  });
});
