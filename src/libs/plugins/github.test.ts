/**
 * GitHub provider — the refusals, and the reason the provider exists.
 *
 * The failure being prevented: an agent asked to change "200+" to "300+" on a
 * client's homepage had to re-emit the whole 84,680-character page to commit
 * it, blew the output-token limit twice, and gave up. Everything here is either
 * "the edit costs nothing regardless of file size" or "an ambiguous edit is
 * refused rather than guessed".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubProvider } from '@/libs/plugins/github';

const TOKEN = 'ghp_test';
const TARGET = 'churchwebglobal/website | main';

/** A homepage with the same "200+" in two places — the real shape of the bug. */
const PAGE = [
  '<section class="hero">',
  '  <div class="counter" data-value="200">200+ churches</div>',
  '</section>',
  '<footer>',
  '  <p>Join 200+ churches worldwide</p>',
  '</footer>',
  '',
].join('\n');

type Call = { url: string; method: string; body?: any };

function stubGh(file = PAGE) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const u = String(url);
    const method = String(init?.method ?? 'GET').toUpperCase();
    calls.push({ url: u, method, body: init?.body ? JSON.parse(init.body) : undefined });

    if (method === 'PUT') {
      return new Response(JSON.stringify({
        commit: { sha: 'abc123', html_url: 'https://github.com/x/y/commit/abc123' },
      }), { status: 200 });
    }
    if (u.includes('/contents/')) {
      return new Response(JSON.stringify({
        type: 'file',
        sha: 'blobsha',
        size: Buffer.byteLength(file),
        content: Buffer.from(file, 'utf8').toString('base64'),
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the point of the provider', () => {
  /**
   * The regression test for the incident. A one-line change must not require
   * the file's contents to travel through the model at all.
   */
  it('commits a change without the caller ever supplying the file', async () => {
    const calls = stubGh();

    const out = JSON.parse(await githubProvider.call(
      'edit_file',
      {
        path: 'index.html',
        edits: [{ find: '<p>Join 200+ churches worldwide</p>', replace: '<p>Join 300+ churches worldwide</p>' }],
        message: 'Update church count to 300+',
      },
      TOKEN,
      TARGET,
    ) as string);

    expect(out.committed).toBe(true);

    const put = calls.find(c => c.method === 'PUT')!;
    const committed = Buffer.from(put.body.content, 'base64').toString('utf8');

    // Exactly the intended change, and nothing else.
    expect(committed).toContain('Join 300+ churches worldwide');
    expect(committed).toContain('data-value="200">200+ churches');
    expect(committed).toBe(PAGE.replace('Join 200+', 'Join 300+'));
  });

  // Without the read's sha, a concurrent commit is silently reverted.
  it('sends the sha it read, so a concurrent change collides instead of vanishing', async () => {
    const calls = stubGh();

    await githubProvider.call(
      'edit_file',
      { path: 'index.html', edits: [{ find: 'Join 200+', replace: 'Join 300+' }], message: 'm' },
      TOKEN,
      TARGET,
    );

    expect(calls.find(c => c.method === 'PUT')!.body.sha).toBe('blobsha');
  });
});

describe('ambiguity is refused, not guessed', () => {
  /**
   * "200+" is in the hero counter AND the footer. Editing "the first one" looks
   * identical to editing the right one in the response, and the client finds
   * out when half their homepage disagrees with the other half.
   */
  it('refuses a find that matches twice, and says how many', async () => {
    const calls = stubGh();

    await expect(githubProvider.call(
      'edit_file',
      { path: 'index.html', edits: [{ find: '200+', replace: '300+' }], message: 'm' },
      TOKEN,
      TARGET,
    )).rejects.toThrow(/found 2 occurrences/);

    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('allows both to change when that is stated explicitly', async () => {
    const calls = stubGh();

    await githubProvider.call(
      'edit_file',
      { path: 'index.html', edits: [{ find: '200+', replace: '300+', replace_all: true }], message: 'm' },
      TOKEN,
      TARGET,
    );

    const committed = Buffer.from(calls.find(c => c.method === 'PUT')!.body.content, 'base64').toString('utf8');

    expect(committed).not.toContain('200+');
  });

  it('reports a find that is not there instead of committing something close', async () => {
    const calls = stubGh();

    await expect(githubProvider.call(
      'edit_file',
      { path: 'index.html', edits: [{ find: 'Join 200 churches', replace: 'x' }], message: 'm' },
      TOKEN,
      TARGET,
    )).rejects.toThrow(/does not appear in this file/);

    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });
});

describe('multiple edits are one commit or none', () => {
  it('applies every edit in a single commit', async () => {
    const calls = stubGh();

    await githubProvider.call(
      'edit_file',
      {
        path: 'index.html',
        edits: [
          { find: 'data-value="200"', replace: 'data-value="300"' },
          { find: '>200+ churches<', replace: '>300+ churches<' },
          { find: 'Join 200+', replace: 'Join 300+' },
        ],
        message: 'm',
      },
      TOKEN,
      TARGET,
    );

    const puts = calls.filter(c => c.method === 'PUT');

    expect(puts).toHaveLength(1);
    expect(Buffer.from(puts[0]!.body.content, 'base64').toString('utf8')).not.toContain('200');
  });

  /**
   * A partial commit leaves the file in a state nobody asked for, and the
   * agent's next move is a second commit fixing its own first one.
   */
  it('commits nothing when a later edit fails', async () => {
    const calls = stubGh();

    await expect(githubProvider.call(
      'edit_file',
      {
        path: 'index.html',
        edits: [
          { find: 'Join 200+', replace: 'Join 300+' },
          { find: 'text that is not present', replace: 'x' },
        ],
        message: 'm',
      },
      TOKEN,
      TARGET,
    )).rejects.toThrow(/does not appear/);

    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('refuses a no-op edit rather than making an empty commit', async () => {
    stubGh();

    await expect(githubProvider.call(
      'edit_file',
      { path: 'index.html', edits: [{ find: 'Join 200+', replace: 'Join 200+' }], message: 'm' },
      TOKEN,
      TARGET,
    )).rejects.toThrow(/identical to "replace"/);
  });
});

describe('create_file', () => {
  // create_file with no sha replaces the whole file — the exact clobber this
  // provider exists to prevent.
  it('refuses to create over an existing path', async () => {
    stubGh();

    await expect(githubProvider.call(
      'create_file',
      { path: 'index.html', content: 'x', message: 'm' },
      TOKEN,
      TARGET,
    )).rejects.toThrow(/already exists/);
  });
});

describe('target parsing', () => {
  it('takes owner and repo from the connection, not the arguments', async () => {
    const calls = stubGh();

    await githubProvider.call('list_files', {}, TOKEN, TARGET);

    expect(calls.at(-1)!.url).toContain('/repos/churchwebglobal/website/contents/');
    expect(calls.at(-1)!.url).toContain('ref=main');
  });

  it('accepts a pasted repository URL', async () => {
    const calls = stubGh();

    await githubProvider.call('list_files', {}, TOKEN, 'https://github.com/churchwebglobal/website.git');

    expect(calls.at(-1)!.url).toContain('/repos/churchwebglobal/website/');
  });

  it('says the connection is unconfigured rather than blaming the call', async () => {
    stubGh();

    await expect(githubProvider.call('list_files', {}, TOKEN, ''))
      .rejects
      .toThrow(/no repository set/);
  });

  it('tolerates a token pasted with a Bearer prefix', async () => {
    const headers: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: any) => {
      headers.push(init?.headers);
      return new Response(JSON.stringify([]), { status: 200 });
    }));

    await githubProvider.call('list_files', { branch: 'main' }, 'Bearer ghp_test', TARGET);

    expect(headers[0].Authorization).toBe('Bearer ghp_test');
  });
});

describe('reading', () => {
  it('search returns line numbers instead of the file body', async () => {
    stubGh();

    const out = JSON.parse(await githubProvider.call(
      'read_file',
      { path: 'index.html', search: '200+' },
      TOKEN,
      TARGET,
    ) as string);

    expect(out.matches).toContain('2:');
    expect(out.matches).toContain('5:');
    expect(out.content).toBeUndefined();
  });

  // An empty search result must read as evidence, not as a truncation — the
  // original incident had the agent conclude a tool was broken.
  it('states plainly that a miss searched the whole file', async () => {
    stubGh();

    const out = JSON.parse(await githubProvider.call(
      'read_file',
      { path: 'index.html', search: 'nowhere-in-this-file' },
      TOKEN,
      TARGET,
    ) as string);

    expect(out.matches).toBeNull();
    expect(out.note).toMatch(/not a truncation/);
  });

  it('refuses a binary file rather than corrupting it', async () => {
    stubGh('abc\0def');

    await expect(githubProvider.call('read_file', { path: 'logo.png' }, TOKEN, TARGET))
      .rejects
      .toThrow(/binary file/);
  });
});

describe('errors', () => {
  it('reads a 404 on a fine-grained token as scope, not a typo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'Not Found' }),
      { status: 404 },
    )));

    await expect(githubProvider.call('list_files', { branch: 'main' }, TOKEN, TARGET))
      .rejects
      .toThrow(/no access to this repository/);
  });

  it('tells the agent not to retry a stale-sha conflict', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: any) => {
      if (String(init?.method ?? 'GET').toUpperCase() === 'PUT') {
        return new Response(JSON.stringify({ message: 'is at 111 but expected 222' }), { status: 409 });
      }
      return new Response(JSON.stringify({
        type: 'file',
        sha: 'blobsha',
        size: PAGE.length,
        content: Buffer.from(PAGE, 'utf8').toString('base64'),
      }), { status: 200 });
    }));

    await expect(githubProvider.call(
      'edit_file',
      { path: 'index.html', edits: [{ find: 'Join 200+', replace: 'Join 300+' }], message: 'm', branch: 'main' },
      TOKEN,
      TARGET,
    )).rejects.toThrow(/do NOT retry with the old sha/);
  });

  it('names the permission a token is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'Resource not accessible by personal access token' }),
      { status: 403 },
    )));

    await expect(githubProvider.call('list_files', { branch: 'main' }, TOKEN, TARGET))
      .rejects
      .toThrow(/Contents → Read and write/);
  });
});
