/**
 * WordPress Sites (Phase 34) — the guardrails, not the happy path.
 * Pure-function checks plus fetch-stubbed discovery and rotation ordering.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAuthHeader, LABEL_RE, maskSecret, normaliseLabel, normaliseSecret, normaliseSiteUrl } from '@/libs/wpsites/auth';
import { resolveRoute } from '@/libs/wpsites/channels';
import { detectBuilder, findMcpRoute } from '@/libs/wpsites/discovery';
import { parseProvisioningPayload } from '@/libs/wpsites/legacy';
import { cliIsWrite, restIsWrite, serialisedForSite, toToolPolicy } from '@/libs/wpsites/policy';
import { redactSecrets } from '@/libs/wpsites/redact';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('auth', () => {
  it('strips a pasted "Bearer " prefix and app-password spaces — the platform owns the header', () => {
    expect(normaliseSecret('bearer', 'Bearer abc123def')).toBe('abc123def');
    expect(normaliseSecret('basic', 'abcd efgh ijkl mnop qrst uvwx')).toBe('abcdefghijklmnopqrstuvwx');
  });

  it('builds Basic from user:secret and Bearer from the raw token', () => {
    expect(buildAuthHeader('basic', 'noah-agent', 'pw')).toBe(`Basic ${Buffer.from('noah-agent:pw').toString('base64')}`);
    expect(buildAuthHeader('bearer', null, 'tok')).toBe('Bearer tok');
    expect(() => buildAuthHeader('basic', '', 'pw')).toThrow(/username/);
  });

  it('masks all but the last four', () => {
    expect(maskSecret('abcdefghijklmnopqrstuvwx')).toMatch(/^•+uvwx$/);
    expect(maskSecret('abcdefghijklmnopqrstuvwx')).not.toContain('abcd');
  });

  it.each([
    ['Noah Build', 'noah-build'],
    ['--x--', 'x'],
    ['build.churchwebglobal.com', 'build-churchwebglobal-com'],
  ])('normalises label %s → %s', (raw, want) => {
    expect(normaliseLabel(raw)).toBe(want);
    expect(LABEL_RE.test(normaliseLabel(raw))).toBe(true);
  });

  it('normalises site URLs (host lowercased, trailing slash dropped, non-http refused)', () => {
    expect(normaliseSiteUrl('https://Example.COM/')).toBe('https://example.com');
    expect(normaliseSiteUrl('https://example.com/blog/')).toBe('https://example.com/blog');
    expect(() => normaliseSiteUrl('example.com')).toThrow(/https/);
    expect(() => normaliseSiteUrl('ftp://example.com')).toThrow();
  });
});

describe('redaction', () => {
  const pw = 'abcdefghijklmnopqrstuvwx';

  it('removes the literal secret, its base64 Basic form, its spaced display form and any Authorization value', () => {
    const b64 = Buffer.from(pw).toString('base64');
    const text = `pw=${pw} b64=${b64} spaced=abcd efgh ijkl mnop qrst uvwx Authorization: Basic Zm9vOmJhcg== and "authorization":"Bearer sk_live_123"`;
    const out = redactSecrets(text, [pw]);

    expect(out).not.toContain(pw);
    expect(out).not.toContain(b64);
    expect(out).not.toContain('abcd efgh');
    expect(out).not.toContain('Zm9vOmJhcg');
    expect(out).not.toContain('sk_live_123');
  });

  it('masks PEM blocks even when the key is not in the list', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----';

    expect(redactSecrets(`key: ${pem}`, [])).toBe('key: [redacted]');
  });

  it('ignores tiny "secrets" so ordinary words survive', () => {
    expect(redactSecrets('the cat sat', ['cat'])).toBe('the cat sat');
  });
});

describe('policy', () => {
  it('maps site policy × read/write onto the loop policy', () => {
    const site = { rest: 'auto', mcp: 'ask', cli: 'blocked' } as const;

    expect(toToolPolicy(site, 'rest', true)).toBe('auto');
    expect(toToolPolicy(site, 'mcp', true)).toBe('approval');
    expect(toToolPolicy(site, 'mcp', false)).toBe('auto'); // reads never need approval
    expect(toToolPolicy(site, 'cli', false)).toBe('deny'); // blocked blocks reads too
  });

  it.each([
    [['option', 'get', 'blogname'], false],
    [['plugin', 'list', '--format=json'], false],
    [['cli', 'info'], false],
    [['search-replace', 'a', 'b', '--dry-run'], false],
    [['search-replace', 'a', 'b'], true],
    [['plugin', 'update', '--all'], true],
    [['option', 'update', 'blogname', 'x'], true],
    [['rewrite', 'flush'], true],
    [[], true],
  ])('cliIsWrite(%j) = %s', (args, want) => {
    expect(cliIsWrite(args)).toBe(want);
  });

  it('REST: only GET/HEAD/OPTIONS are reads', () => {
    expect(restIsWrite('get')).toBe(false);
    expect(restIsWrite('POST')).toBe(true);
    expect(restIsWrite('DELETE')).toBe(true);
  });

  it('serialises writes per site and lets other sites proceed', async () => {
    const order: string[] = [];
    const slow = (tag: string, ms: number) => () => new Promise<void>(r => setTimeout(() => {
      order.push(tag);
      r();
    }, ms));
    await Promise.all([
      serialisedForSite('A', slow('A1', 30)),
      serialisedForSite('A', slow('A2', 1)),
      serialisedForSite('B', slow('B1', 1)),
    ]);

    expect(order.indexOf('A1')).toBeLessThan(order.indexOf('A2'));
    expect(order.indexOf('B1')).toBeLessThan(order.indexOf('A2'));
  });
});

describe('routes', () => {
  it('relative routes land under /wp-json; absolute routes must stay on the site host', () => {
    expect(resolveRoute('https://x.com', '/wp/v2/posts')).toBe('https://x.com/wp-json/wp/v2/posts');
    expect(resolveRoute('https://x.com', 'wp/v2/posts?a=1')).toBe('https://x.com/wp-json/wp/v2/posts?a=1');
    expect(resolveRoute('https://x.com', '/wp-json/mcp/x')).toBe('https://x.com/wp-json/mcp/x');
    expect(resolveRoute('https://x.com', 'https://x.com/wp-json/mcp/x')).toBe('https://x.com/wp-json/mcp/x');
    expect(() => resolveRoute('https://x.com', 'https://evil.com/steal')).toThrow(/refusing/);
  });
});

describe('discovery', () => {
  it('finds the MCP adapter route, preferring adapter-default and skipping regex routes', () => {
    expect(findMcpRoute({ routes: { '/wp/v2': {}, '/mcp/mcp-adapter-default': {}, '/mcp/oxygen': {}, '/mcp/(?P<id>\\d+)': {} } })).toBe('/mcp/mcp-adapter-default');
    expect(findMcpRoute({ routes: { '/mcp/oxygen-agent': {}, '/mcp': {} } })).toBe('/mcp/oxygen-agent');
    expect(findMcpRoute({ routes: { '/wp/v2': {} }, namespaces: ['wp/v2'] })).toBeNull();
    expect(findMcpRoute({ routes: {}, namespaces: ['mcp/v1'] })).toBe('/mcp/v1/mcp');
  });

  it('detects the builder from MCP ability prefixes first, then namespaces, then plugins', () => {
    const a = detectBuilder({ mcpTools: ['oxygen/update-element', 'core/get-post'] });

    expect(a.builder).toBe('oxygen');
    expect(a.abilities).toEqual(['oxygen/update-element']);
    expect(detectBuilder({ namespaces: ['wp/v2', 'elementor/v1'] }).builder).toBe('elementor');

    const c = detectBuilder({ plugins: [{ name: 'bricks', version: '1.9' }] });

    expect(c.builder).toBe('bricks');
    expect(c.version).toBe('1.9');
    expect(detectBuilder({ themes: [{ name: 'Divi', status: 'active' }] }).builder).toBe('divi');
    expect(detectBuilder({}).builder).toBe('gutenberg');
  });
});

describe('provisioning payload', () => {
  it('accepts the hook JSON and rejects partial ones', () => {
    expect(parseProvisioningPayload('{"site_url":"https://a.com","username":"u","app_password":"p"}')).toEqual({ site_url: 'https://a.com', username: 'u', app_password: 'p', label: undefined });
    expect(() => parseProvisioningPayload('{"site_url":"https://a.com"}')).toThrow(/username/);
    expect(() => parseProvisioningPayload('nope')).toThrow(/JSON/);
  });
});

describe('rotation ordering (fetch-stubbed)', () => {
  it('creates, verifies with the NEW secret, persists, then deletes the old by uuid', async () => {
    const calls: Array<{ method: string; url: string; auth: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      calls.push({ method: init?.method ?? 'GET', url, auth });
      if (url.endsWith('/introspect')) {
        return new Response(JSON.stringify({ uuid: 'old-uuid', name: 'old' }), { status: 200 });
      }
      if (url.endsWith('/application-passwords') && init?.method === 'POST') {
        return new Response(JSON.stringify({ password: 'newnewnewnewnewnewnewnew', uuid: 'new-uuid' }), { status: 201 });
      }
      if (url.includes('/users/me?context=edit')) {
        return new Response(JSON.stringify({ slug: 'noah-agent', roles: ['administrator'] }), { status: 200 });
      }
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }));
    vi.doMock('@/libs/wpsites/store', () => ({ replaceSiteSecret: vi.fn(async () => {}) }));
    const { rotateAppPassword } = await import('@/libs/wpsites/rotate');
    const store = await import('@/libs/wpsites/store');
    const site = {
      id: 's1',
      tenantId: 't1',
      label: 'noah',
      isDefault: true,
      siteUrl: 'https://noah.test',
      authScheme: 'basic' as const,
      authUser: 'noah-agent',
      authSecret: 'oldoldoldoldoldoldoldold',
      appPasswordUuid: null,
      ssh: null,
      mcpEndpointUrl: null,
      builder: null,
      capabilities: { rest: true, mcp: false, cli: false, builder_abilities: [], plugins: [], mcp_tools: [], namespaces: [], base_plugin: false, roles: [] },
      policy: { rest: 'auto' as const, mcp: 'ask' as const, cli: 'ask' as const },
      status: 'healthy' as const,
    };
    const result = await rotateAppPassword(site, 'ws');

    expect(result.uuid).toBe('new-uuid');
    expect(result.revokedOld).toBe(true);
    expect(store.replaceSiteSecret).toHaveBeenCalledWith('t1', 's1', 'newnewnewnewnewnewnewnew', 'new-uuid');

    const newAuth = `Basic ${Buffer.from('noah-agent:newnewnewnewnewnewnewnew').toString('base64')}`;
    const verify = calls.find(c => c.url.includes('/users/me?context=edit'));
    const del = calls.find(c => c.method === 'DELETE');

    expect(verify?.auth).toBe(newAuth);
    expect(del?.url).toContain('/application-passwords/old-uuid');
    expect(del?.auth).toBe(newAuth);
    // Verify happened BEFORE the delete.
    expect(calls.indexOf(verify!)).toBeLessThan(calls.indexOf(del!));

    vi.doUnmock('@/libs/wpsites/store');
  });
});

describe('acceptance: no "Bearer" in the Sites UI', () => {
  it('the panel never shows the word Bearer or a header name', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../features/agent/WpSitesPanel.tsx', import.meta.url), 'utf8');

    // The lowercase enum value 'bearer' is the API's scheme id and never rendered;
    // the capitalised prefix is what a user would see.
    expect(src).not.toMatch(/Bearer/);
    expect(src).not.toMatch(/Authorization/);
  });
});
