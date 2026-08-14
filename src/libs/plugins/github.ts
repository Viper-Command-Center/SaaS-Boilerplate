/**
 * GitHub repository — built-in provider (per-connection).
 *
 * 🔴 WHY THIS EXISTS, given GitHub publishes a perfectly good hosted MCP server.
 *
 * The hosted server's only write verb is `create_or_update_file`, which takes
 * the ENTIRE new file as an argument. To change three words on a client's
 * homepage the agent must therefore re-emit every byte of that homepage as
 * tool-call JSON. The page that prompted this is 84,680 characters — roughly
 * 22,000 output tokens against a 16,384 limit. The model physically cannot
 * finish the call. It got cut off mid-argument, the loop's recovery prompt
 * asked it to try again more compactly, it produced the same 22,000-token call,
 * and the turn ended with "hit the output-length limit twice in a row".
 *
 * Raising max_tokens would not fix this, it would only move the wall — and the
 * failure mode on the far side is worse than an error. An agent retyping 85,000
 * characters from context is transcribing, and transcription drifts: a dropped
 * closing brace or a silently "improved" sentence three screens away from the
 * intended edit, committed straight to a live client site. The whole file is
 * the diff, so nothing in the approval screen distinguishes the three words
 * that were meant to change from the paragraph that was not.
 *
 * So the edit happens HERE. The agent sends the text to find and the text to
 * put in its place — tens of tokens — and this adapter fetches, replaces,
 * and commits. Cost stops scaling with file size, the diff is genuinely three
 * words, and everything the agent never sent is byte-identical by construction
 * rather than by luck.
 *
 * The single load-bearing rule: a `find` string that does not match EXACTLY
 * ONCE is refused. Ambiguity is the way this breaks — a homepage saying "200+"
 * in a hero counter and again in a footer CTA is the normal case, not the edge
 * case, and picking one of them silently is indistinguishable from picking the
 * right one until a client notices.
 *
 * Credential: a fine-grained PAT with Contents → Read and write on the repo.
 * Target: "owner/repo", optionally "owner/repo | branch".
 */

import type { BuiltinProvider, BuiltinTool } from '@/libs/plugins/types';

const API = 'https://api.github.com';

/**
 * The contents API refuses to inline anything larger, and a file that big is
 * not something an agent should be editing by string match anyway.
 */
const MAX_FILE_BYTES = 1_000_000;

/** Matches the platform's read_file window, so paging behaves the same way. */
const MAX_READ_CHARS = 60_000;

type Repo = { owner: string; repo: string; branch?: string };

/**
 * "owner/repo" or "owner/repo | branch". Also accepts a pasted browser URL,
 * because that is what is on the clipboard when someone fills the form in.
 *
 * 🔴 The owner lives in the TARGET, not in the tool arguments. An earlier
 * incident had an AI employee report a missing `owner` parameter as an Artivio
 * misconfiguration — it was a malformed call, but the deeper problem was that
 * the agent was being asked for a fact about the connection at all. It cannot
 * get this wrong if it is never asked.
 */
function parseTarget(target: string | undefined): Repo {
  const raw = String(target ?? '').trim();
  if (!raw) {
    throw new Error(
      'GitHub: this connection has no repository set. Its target must be "owner/repo" '
      + '(optionally "owner/repo | branch"). Ask the workspace admin to set it — you cannot supply it per call.',
    );
  }

  const [left, branchPart] = raw.split('|').map(s => s.trim());
  const cleaned = String(left)
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');

  const [owner, repo] = cleaned.split('/');
  if (!owner || !repo) {
    throw new Error(`GitHub: target "${raw}" is not "owner/repo".`);
  }

  return { owner, repo, branch: branchPart || undefined };
}

async function gh(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<any> {
  const method = (init?.method ?? (init?.body === undefined ? 'GET' : 'PUT')).toUpperCase();

  let resp: Response;
  try {
    resp = await fetch(`${API}${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        'Authorization': `Bearer ${token.replace(/^Bearer\s+/i, '')}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'artivio',
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (e) {
    throw new Error(`GitHub: could not reach the API — ${e instanceof Error ? e.message : String(e)}`);
  }

  const body = await resp.json().catch(() => ({})) as any;

  if (!resp.ok) {
    const msg = String(body?.message ?? `HTTP ${resp.status}`);

    // The three failures whose own wording sends people to the wrong screen.
    if (resp.status === 404) {
      throw new Error(
        `GitHub: not found (${msg}). On a fine-grained token a 404 usually means the token has no access to `
        + 'this repository rather than that the path is wrong — check the repo is in the token\'s scope '
        + 'before assuming a typo in the path.',
      );
    }
    if (resp.status === 403 && /rate limit/i.test(msg)) {
      throw new Error(`GitHub: rate limited (${msg}). Wait and retry; do not loop.`);
    }
    if (resp.status === 403 || resp.status === 401) {
      throw new Error(
        `GitHub: ${msg}. The token needs Contents → Read and write on this repository. `
        + 'This is a credential the workspace admin fixes, not something to work around.',
      );
    }
    if (resp.status === 409) {
      throw new Error(
        `GitHub: conflict (${msg}). The file changed after it was read. Read it again and redo the edit — `
        + 'do NOT retry with the old sha, that would overwrite whatever the other change was.',
      );
    }
    throw new Error(`GitHub ${resp.status}: ${msg}`);
  }

  return body;
}

async function defaultBranch(token: string, r: Repo): Promise<string> {
  if (r.branch) {
    return r.branch;
  }
  const info = await gh(token, `/repos/${r.owner}/${r.repo}`);
  return String(info.default_branch ?? 'main');
}

function q(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Fetch one text file, decoded, with its blob sha for optimistic concurrency. */
async function getTextFile(
  token: string,
  r: Repo,
  path: string,
  ref: string,
): Promise<{ text: string; sha: string; size: number }> {
  const clean = String(path ?? '').replace(/^\/+/, '');
  if (!clean) {
    throw new Error('GitHub: provide path (e.g. "src/app/page.tsx").');
  }

  const body = await gh(token, `/repos/${r.owner}/${r.repo}/contents/${q(clean)}?ref=${encodeURIComponent(ref)}`);

  if (Array.isArray(body)) {
    throw new Error(`GitHub: "${clean}" is a directory, not a file. Use list_files to see what is in it.`);
  }
  if (body.type !== 'file') {
    throw new Error(`GitHub: "${clean}" is a ${body.type ?? 'non-file'}, which this plugin cannot edit.`);
  }
  if (Number(body.size) > MAX_FILE_BYTES) {
    throw new Error(
      `GitHub: "${clean}" is ${Number(body.size).toLocaleString()} bytes, past the ${MAX_FILE_BYTES.toLocaleString()}-byte `
      + 'limit for content edits. A file this large needs a human with a checkout.',
    );
  }

  const text = Buffer.from(String(body.content ?? ''), 'base64').toString('utf8');

  // A NUL byte means it is not text, and a string replacement on a decoded
  // binary would corrupt it on the way back through UTF-8.
  if (text.includes('\0')) {
    throw new Error(`GitHub: "${clean}" is a binary file. This plugin edits text only.`);
  }

  return { text, sha: String(body.sha), size: Number(body.size) };
}

/** The line number a character offset falls on, for reporting where an edit landed. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
    }
  }
  return line;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Apply one edit, or explain precisely why it was refused.
 *
 * Returns the new text plus a human-readable record of what moved, which is
 * what the approval screen shows. Never returns the file.
 */
function applyEdit(
  text: string,
  edit: { find: string; replace: string; replace_all?: boolean },
  index: number,
): { text: string; note: string } {
  const find = String(edit.find ?? '');
  const replace = String(edit.replace ?? '');

  if (find === '') {
    throw new Error(`GitHub: edit ${index + 1} has an empty "find". There is nothing to locate.`);
  }
  if (find === replace) {
    throw new Error(
      `GitHub: edit ${index + 1} has "find" identical to "replace" — it would produce an empty commit. `
      + 'Check you are not looking at the value you already wrote.',
    );
  }

  const hits = countOccurrences(text, find);

  if (hits === 0) {
    throw new Error(
      `GitHub: edit ${index + 1} — the text to find does not appear in this file:\n${JSON.stringify(find.slice(0, 200))}\n`
      + 'Nothing was committed. Read the file (or search it) and copy the exact text, including whitespace, '
      + 'case and any HTML tags inside it. Do not guess at a close variant.',
    );
  }

  /**
   * 🔴 The rule this whole adapter is built around.
   *
   * "200+" appears in a hero counter AND a footer CTA on the same page. Editing
   * "the first one" is a coin flip that looks like a success in the response,
   * and the wrong half of a client's homepage now disagrees with itself. The
   * caller must disambiguate by including surrounding text — which it can do
   * cheaply, because it already has the file's structure from search.
   */
  if (hits > 1 && edit.replace_all !== true) {
    throw new Error(
      `GitHub: edit ${index + 1} — found ${hits} occurrences of ${JSON.stringify(find.slice(0, 120))}, so it is ambiguous. `
      + 'Nothing was committed. Either include enough surrounding text to make it unique (the enclosing tag, '
      + 'the neighbouring words), or — only if you have confirmed every occurrence should change — pass '
      + 'replace_all: true on this edit.',
    );
  }

  const at = text.indexOf(find);
  const line = lineOf(text, at);

  const out = edit.replace_all === true
    ? text.split(find).join(replace)
    : text.slice(0, at) + replace + text.slice(at + find.length);

  const shorten = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);

  return {
    text: out,
    note: hits > 1
      ? `all ${hits} occurrences: ${JSON.stringify(shorten(find))} → ${JSON.stringify(shorten(replace))}`
      : `line ${line}: ${JSON.stringify(shorten(find))} → ${JSON.stringify(shorten(replace))}`,
  };
}

const tools: BuiltinTool[] = [
  {
    name: 'list_files',
    description: 'List a directory in the repository. Path "" or omitted lists the root. Use this to find a file before reading it.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path, e.g. "src/app". Omit for the repo root.' },
        branch: { type: 'string', description: 'Branch or tag. Defaults to the connection\'s branch, or the repo default.' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the repository. For a large file pass `search` to get every matching line with its line number and context — that is the right way to locate the text you intend to edit, and an empty result from it is real evidence of absence rather than a truncation. Use `offset`/`limit` only to page through deliberately. You do NOT need to read a whole file in order to edit it.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        search: { type: 'string', description: 'Case-insensitive. Returns matching lines with line numbers and one line of context either side, instead of the file body.' },
        offset: { type: 'number', description: 'Character offset to start from (default 0).' },
        limit: { type: 'number', description: `Characters to return (default and max ${MAX_READ_CHARS}).` },
        branch: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description: 'Change existing text in a repository file and commit it, WITHOUT sending the file back. Supply only the exact text to find and what to replace it with; the file is fetched, patched and committed on the server. This is how you edit any existing file — never rewrite a whole file to change part of it. Each `find` must match exactly once, so include enough surrounding text to be unambiguous. Multiple edits to the same file go in one call and become one commit.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path in the repo, e.g. "src/app/page.tsx".' },
        edits: {
          type: 'array',
          description: 'Applied in order. All must succeed or nothing is committed.',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: 'Exact text to locate, copied verbatim from the file — whitespace, case and tags included. May span lines.' },
              replace: { type: 'string', description: 'What to put in its place. Empty string deletes the found text.' },
              replace_all: { type: 'boolean', description: 'Only when EVERY occurrence should change. Without this, a find that matches more than once is refused rather than guessed at.' },
            },
            required: ['find', 'replace'],
          },
        },
        message: { type: 'string', description: 'Commit message — say what changed and why, as a human would.' },
        branch: { type: 'string' },
      },
      required: ['path', 'edits', 'message'],
    },
  },
  {
    name: 'create_file',
    description: 'Create a NEW file with content you are authoring. Refuses if the path already exists — use edit_file to change an existing file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        message: { type: 'string' },
        branch: { type: 'string' },
      },
      required: ['path', 'content', 'message'],
    },
  },
];

export const githubProvider: BuiltinProvider = {
  slug: 'github-repo',
  name: 'GitHub repository',
  description: 'Read and edit files in one GitHub repository. Edits are applied server-side by find-and-replace, so changing part of a large file costs a few tokens instead of the whole file.',
  credentialLabel: 'Fine-grained personal access token with Contents → Read and write on this repository',
  perConnection: true,
  targetLabel: 'Repository — "owner/repo", or "owner/repo | branch" to pin a branch',
  targetPlaceholder: 'churchwebglobal/website | main',
  targetIsUrl: false,

  guidance: [
    'GitHub: to change existing text, use edit_file — find/replace applied on the server.',
    'NEVER read a file in order to write it back with create_or_update_file or similar: a page of any',
    'real size exceeds the output limit, the call gets cut off mid-argument, and even when it fits you are',
    'retyping thousands of characters you did not intend to change.',
    'Locate text with read_file + search (returns line numbers), then edit_file with enough surrounding',
    'text that the find matches once. A find matching twice is REFUSED, not guessed — that refusal is',
    'protecting you from editing the footer instead of the hero.',
    'The owner and repo come from the connection, never from you. If a tool seems to want an owner,',
    'you are calling the wrong tool.',
  ].join(' '),

  tools,

  async call(tool, args, credential, target) {
    const token = String(credential ?? '').trim();
    if (!token) {
      throw new Error('GitHub: no access token on this connection.');
    }

    const r = parseTarget(target);
    const branch = String(args.branch ?? '').trim() || await defaultBranch(token, r);
    const repoLabel = `${r.owner}/${r.repo}@${branch}`;

    if (tool === 'list_files') {
      const path = String(args.path ?? '').replace(/^\/+|\/+$/g, '');
      const body = await gh(
        token,
        `/repos/${r.owner}/${r.repo}/contents/${path ? q(path) : ''}?ref=${encodeURIComponent(branch)}`,
      );
      const items = Array.isArray(body) ? body : [body];
      return JSON.stringify({
        repo: repoLabel,
        path: path || '/',
        entries: items.map((i: any) => ({ name: i.name, type: i.type, size: i.size })),
      });
    }

    if (tool === 'read_file') {
      const path = String(args.path ?? '');
      const file = await getTextFile(token, r, path, branch);
      const body = file.text;

      if (args.search !== undefined && String(args.search).trim() !== '') {
        const needle = String(args.search).toLowerCase();
        const lines = body.split('\n');
        const hits: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]?.toLowerCase().includes(needle)) {
            continue;
          }
          const from = Math.max(0, i - 1);
          const to = Math.min(lines.length - 1, i + 1);
          for (let j = from; j <= to; j++) {
            hits.push(`${j + 1}${j === i ? ':' : '-'} ${lines[j]}`);
          }
          hits.push('--');
          if (hits.length > 400) {
            hits.push('(more matches not shown — use a more specific search term)');
            break;
          }
        }
        return JSON.stringify({
          repo: repoLabel,
          path,
          totalLines: lines.length,
          totalChars: body.length,
          search: String(args.search),
          matches: hits.length ? hits.join('\n') : null,
          note: hits.length
            ? 'Line numbers prefix each match; ":" marks the matching line, "-" its context. To change one of '
              + 'these, pass the matching line (or a unique part of it) to edit_file as `find` — do not fetch the file body.'
            : `No line contains "${String(args.search)}". This searched the WHOLE file, so that is a real answer, not a truncation.`,
        });
      }

      const offset = Math.max(0, Number(args.offset) || 0);
      const limit = Math.min(Math.max(Number(args.limit) || MAX_READ_CHARS, 1), MAX_READ_CHARS);
      const slice = body.slice(offset, offset + limit);
      const end = offset + slice.length;

      if (end < body.length || offset > 0) {
        return JSON.stringify({
          repo: repoLabel,
          path,
          totalChars: body.length,
          range: `${offset}-${end}`,
          remaining: body.length - end,
          content: slice,
          note: end < body.length
            ? `There are ${body.length - end} more characters. Use search to jump straight to what you need — `
              + 'and remember edit_file does not require you to have read the rest.'
            : 'End of file.',
        });
      }

      return JSON.stringify({ repo: repoLabel, path, totalChars: body.length, content: body });
    }

    if (tool === 'edit_file') {
      const path = String(args.path ?? '');
      const edits = Array.isArray(args.edits) ? args.edits : [];
      if (edits.length === 0) {
        throw new Error('GitHub: edit_file needs at least one { find, replace } in `edits`.');
      }

      const file = await getTextFile(token, r, path, branch);

      /**
       * All-or-nothing. A partial commit — edits 1 and 2 applied, edit 3
       * refused — leaves the file in a state nobody asked for and no one is
       * looking at, and the agent's next move would be a second commit fixing
       * its own first one. Build the whole result before writing anything.
       */
      let next = file.text;
      const notes: string[] = [];
      for (let i = 0; i < edits.length; i++) {
        const result = applyEdit(next, edits[i] as any, i);
        next = result.text;
        notes.push(result.note);
      }

      if (next === file.text) {
        throw new Error('GitHub: the edits produced no change. Nothing was committed.');
      }

      const commit = await gh(token, `/repos/${r.owner}/${r.repo}/contents/${q(path.replace(/^\/+/, ''))}`, {
        method: 'PUT',
        body: {
          message: String(args.message ?? `Update ${path}`),
          content: Buffer.from(next, 'utf8').toString('base64'),
          // The sha we just read. If anything else committed in between,
          // GitHub rejects this rather than silently reverting their work.
          sha: file.sha,
          branch,
        },
      });

      return JSON.stringify({
        committed: true,
        repo: repoLabel,
        path,
        commit: commit?.commit?.sha ?? null,
        url: commit?.commit?.html_url ?? null,
        changes: notes,
        sizeBefore: file.text.length,
        sizeAfter: next.length,
        note: 'Only the text listed in `changes` differs; the rest of the file was never rewritten. '
          + 'If this repo deploys on push, the change is live once the build finishes — verify the page rather than assuming.',
      });
    }

    if (tool === 'create_file') {
      const path = String(args.path ?? '').replace(/^\/+/, '');
      if (!path) {
        throw new Error('GitHub: provide path.');
      }

      // Refuse rather than overwrite. create_file without a sha silently
      // replaces an existing file's entire contents, which is the exact
      // whole-file clobber this provider exists to prevent.
      let exists = false;
      try {
        await getTextFile(token, r, path, branch);
        exists = true;
      } catch {
        exists = false;
      }
      if (exists) {
        throw new Error(
          `GitHub: "${path}" already exists. Use edit_file to change it — create_file would replace the whole file.`,
        );
      }

      const commit = await gh(token, `/repos/${r.owner}/${r.repo}/contents/${q(path)}`, {
        method: 'PUT',
        body: {
          message: String(args.message ?? `Add ${path}`),
          content: Buffer.from(String(args.content ?? ''), 'utf8').toString('base64'),
          branch,
        },
      });

      return JSON.stringify({
        created: true,
        repo: repoLabel,
        path,
        commit: commit?.commit?.sha ?? null,
        url: commit?.commit?.html_url ?? null,
      });
    }

    throw new Error(`Unknown GitHub tool: ${tool}`);
  },
};
