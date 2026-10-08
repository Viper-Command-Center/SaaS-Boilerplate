/**
 * Creatomate adapter — what is worth testing without an account.
 *
 * The failures that matter: a modification key that matches no element (the
 * render "succeeds" and nothing changes), a media element given a non-URL, and
 * a refused render that still spent credits. Nothing touches the network —
 * `fetch` is stubbed with a small router.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkModifications, cleanKey, collectFields, creatomateProvider } from '@/libs/plugins/creatomate';

const TEMPLATE = {
  id: 'tpl_1',
  name: 'Hook + clip',
  source: {
    output_format: 'mp4',
    width: 1080,
    height: 1920,
    duration: 12,
    elements: [
      { id: 'a1', name: 'Hook', type: 'text', text: 'Where did my paycheque go?' },
      { id: 'a2', name: 'Clip', type: 'video', source: 'https://example.com/default.mp4' },
      { id: 'a3', type: 'shape' },
      { id: 'a4', name: 'End card', type: 'composition', elements: [{ id: 'a5', name: 'CTA', type: 'text', text: 'Try BudgetSmart AI' }] },
    ],
  },
};

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

function route(handler: (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = handler(call) ?? { status: 404, body: { hint: 'no route' } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers });
  }));
  return calls;
}

const run = (tool: string, args: Record<string, unknown>, credential = 'key-123456') =>
  creatomateProvider.call(tool, args, credential);

beforeEach(() => {
  process.env.CREATOMATE_POLL_MS = '1';
  delete process.env.CREATOMATE_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('template introspection', () => {
  it('collects named elements, nested ones included, and skips unnamed', () => {
    const names = collectFields(TEMPLATE.source).map(f => f.name);

    expect(names).toEqual(['Hook', 'Clip', 'End card', 'CTA']);
    expect(collectFields(undefined)).toEqual([]);
  });

  it('refuses an unknown key and names the real ones', () => {
    const fields = collectFields(TEMPLATE.source);
    const problem = checkModifications(fields, { Headline: 'x' });

    expect(problem).toMatch(/not an element/);
    expect(problem).toMatch(/Hook \(text\)/);
  });

  it('accepts names, ids and property paths; refuses a non-URL on a media element', () => {
    const fields = collectFields(TEMPLATE.source);

    expect(checkModifications(fields, { 'Hook': 'hi', 'a1': 'hi', 'Hook.fill_color': '#fff', 'CTA': 'Go' })).toBeNull();
    expect(checkModifications(fields, { Clip: '/local/file.mp4' })).toMatch(/PUBLIC http/);
    expect(checkModifications(fields, { Clip: 'https://s.artivio.ai/a.mp4' })).toBeNull();
  });
});

describe('key handling', () => {
  it('strips a pasted Bearer prefix and falls back to the platform env key', () => {
    expect(cleanKey('Bearer abc')).toBe('abc');

    process.env.CREATOMATE_API_KEY = 'env-key';

    expect(cleanKey('')).toBe('env-key');
    expect(cleanKey('own')).toBe('own');
  });

  it('errors plainly with no key anywhere', async () => {
    await expect(run('list_templates', {}, '')).rejects.toThrow(/No Creatomate API key/);
  });
});

describe('render', () => {
  it('refuses a bad key BEFORE any render request (nothing spent)', async () => {
    const calls = route(c => (c.url.includes('/v2/templates/tpl_1') ? { body: TEMPLATE } : undefined));

    await expect(run('render', { template_id: 'tpl_1', modifications: { Nope: 'x' } })).rejects.toThrow(/nothing was spent/);

    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('sends the key as a Bearer header and polls to success, returning the file for archiving', async () => {
    let polls = 0;
    const calls = route((c) => {
      if (c.url.includes('/v2/templates/tpl_1')) {
        return { body: TEMPLATE };
      }
      if (c.method === 'POST' && c.url.endsWith('/v2/renders')) {
        return { status: 202, body: { id: 'r1', status: 'planned' } };
      }
      if (c.url.endsWith('/v2/renders/r1')) {
        polls += 1;
        return { body: polls < 2 ? { id: 'r1', status: 'rendering' } : { id: 'r1', status: 'succeeded', url: 'https://cdn.creatomate.com/r1.mp4', duration: 11.8, width: 1080, height: 1920 } };
      }
      return undefined;
    });
    const out = await run('render', { template_id: 'tpl_1', modifications: { Hook: 'Hello' }, max_width: 540 }) as { output: string; assetUrls?: string[] };
    const post = calls.find(c => c.method === 'POST')!;

    expect(post.headers.Authorization).toBe('Bearer key-123456');
    expect(post.body).toEqual({ template_id: 'tpl_1', modifications: { Hook: 'Hello' }, max_width: 540 });
    expect(JSON.parse(out.output).status).toBe('succeeded');
    expect(out.assetUrls).toEqual(['https://cdn.creatomate.com/r1.mp4']);
  });

  it('dry_run validates without rendering', async () => {
    const calls = route((c) => {
      if (c.url.includes('/v2/templates/tpl_1')) {
        return { body: TEMPLATE };
      }
      return { body: { valid: true, errors: [], warnings: ['x'] } };
    });
    const out = JSON.parse(await run('render', { template_id: 'tpl_1', modifications: { Hook: 'Hi' }, dry_run: true }) as string);

    expect(calls.find(c => c.method === 'POST')!.body.dry_run).toBe(true);
    expect(out).toMatchObject({ dry_run: true, valid: true, warnings: ['x'] });
  });

  it('turns a failed render and the common HTTP errors into plain messages', async () => {
    route((c) => {
      if (c.url.includes('/v2/templates/tpl_1')) {
        return { body: TEMPLATE };
      }
      if (c.method === 'POST') {
        return { status: 202, body: { id: 'r2', status: 'planned' } };
      }
      return { body: { id: 'r2', status: 'failed', error_message: 'font missing' } };
    });

    await expect(run('render', { template_id: 'tpl_1', modifications: {} })).rejects.toThrow(/font missing/);

    route(() => ({ status: 401, body: { hint: 'bad key' } }));

    await expect(run('list_templates', {})).rejects.toThrow(/PROJECT API key/);

    route(() => ({ status: 402, body: { hint: 'no credits' } }));

    await expect(run('list_templates', {})).rejects.toThrow(/out of render credits/);
  });

  it('returns the id when the wait window ends instead of failing', async () => {
    route(() => ({ body: { id: 'r3', status: 'rendering' } }));
    const out = JSON.parse(await run('check_render', { render_id: 'r3' }) as string);

    expect(out).toMatchObject({ render_id: 'r3', status: 'rendering' });
  });
});

describe('list_templates', () => {
  it('lists id/name/tags and passes tag filters', async () => {
    const calls = route(() => ({ body: [{ id: 't1', name: 'A', tags: ['hook'] }] }));
    const out = JSON.parse(await run('list_templates', { tags: ['hook', 'vertical'] }) as string);

    expect(calls[0]!.url).toContain('?tags=hook%2Cvertical');
    expect(out.templates).toEqual([{ template_id: 't1', name: 'A', tags: ['hook'] }]);
  });
});
