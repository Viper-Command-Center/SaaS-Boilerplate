/**
 * Artivio mcp-sites — multi-site website-update MCP server (zero dependencies).
 *
 * Exposes MCP tools (JSON-RPC 2.0 over HTTP) that read and edit files in the
 * GitHub repos behind Ryan's Railway-hosted sites. Because every site
 * auto-deploys from `main`, "commit to main" IS the deploy mechanism — no
 * Railway API needed. WordPress sites should use the WordPress MCP instead.
 *
 * Env:
 *   PORT          — provided by Railway
 *   MCP_API_KEY   — bearer token clients must send (paste the same value into
 *                   the Command Center Tools panel as the Authorization header:
 *                   "Bearer <MCP_API_KEY>")
 *   GITHUB_TOKEN  — fine-grained PAT with Contents read/write on the site repos
 *   SITES         — JSON: { "<site-id>": { "owner": "org", "repo": "name",
 *                   "branch": "main", "label": "Human name" }, ... }
 *
 * Safety: path traversal blocked, .git and workflow files untouchable,
 * 400 KB max file size, every commit is attributed to the Command Center.
 * The Command Center's own approvals gateway gates these tools by default.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT) || 8080;
const API_KEY = process.env.MCP_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const MAX_FILE_BYTES = 400_000;

function sites() {
  try {
    return JSON.parse(process.env.SITES || '{}');
  } catch {
    return {};
  }
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function gh(path, init = {}) {
  const resp = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'artivio-mcp-sites',
      ...(init.headers || {}),
    },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`GitHub ${resp.status}: ${(body.message || '').slice(0, 200)}`);
  }
  return body;
}

function resolveSite(siteId) {
  const site = sites()[siteId];
  if (!site || !site.owner || !site.repo) {
    throw new Error(`Unknown site "${siteId}". Use list_sites to see configured sites.`);
  }
  return { branch: 'main', ...site };
}

function safePath(p) {
  const path = String(p || '').replace(/^\/+/, '');
  if (!path || path.includes('..') || path.startsWith('.git') || path.startsWith('.github/workflows')) {
    throw new Error('Path not allowed.');
  }
  return path;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_sites',
    description: 'List the websites this server can read and edit. Every edit commits to the site\'s GitHub repo, which triggers its Railway auto-deploy.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const s = sites();
      const list = Object.entries(s).map(([id, v]) => ({ id, label: v.label || id, repo: `${v.owner}/${v.repo}`, branch: v.branch || 'main' }));
      return JSON.stringify(list.length > 0 ? list : { error: 'No sites configured (SITES env var is empty).' });
    },
  },
  {
    name: 'list_files',
    description: 'List files/directories at a path in a site\'s repo (like ls). Use to explore the site structure before editing.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site id from list_sites' },
        path: { type: 'string', description: 'Directory path, empty for repo root' },
      },
      required: ['site'],
    },
    run: async (args) => {
      const site = resolveSite(args.site);
      const path = args.path ? safePath(args.path) : '';
      const body = await gh(`/repos/${site.owner}/${site.repo}/contents/${encodeURI(path)}?ref=${site.branch}`);
      const entries = Array.isArray(body) ? body : [body];
      return JSON.stringify(entries.map(e => ({ name: e.name, path: e.path, type: e.type, size: e.size })));
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from a site\'s repo (page components, content, config).',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['site', 'path'],
    },
    run: async (args) => {
      const site = resolveSite(args.site);
      const path = safePath(args.path);
      const body = await gh(`/repos/${site.owner}/${site.repo}/contents/${encodeURI(path)}?ref=${site.branch}`);
      if (body.type !== 'file') {
        throw new Error('Not a file.');
      }
      if (body.size > MAX_FILE_BYTES) {
        throw new Error(`File too large (${body.size} bytes; limit ${MAX_FILE_BYTES}).`);
      }
      return Buffer.from(body.content || '', 'base64').toString('utf8');
    },
  },
  {
    name: 'update_file',
    description: 'Replace the full contents of an existing file and commit to the site\'s deploy branch. The site auto-deploys from that branch — this IS the publish action. Read the file first and submit the complete new contents.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string', description: 'Complete new file contents (UTF-8)' },
        commit_message: { type: 'string', description: 'Why this change is being made' },
      },
      required: ['site', 'path', 'content', 'commit_message'],
    },
    run: async (args) => {
      const site = resolveSite(args.site);
      const path = safePath(args.path);
      const content = String(args.content ?? '');
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
        throw new Error(`Content too large (limit ${MAX_FILE_BYTES} bytes).`);
      }
      const current = await gh(`/repos/${site.owner}/${site.repo}/contents/${encodeURI(path)}?ref=${site.branch}`);
      if (current.type !== 'file') {
        throw new Error('Not a file — use create_file for new files.');
      }
      const body = await gh(`/repos/${site.owner}/${site.repo}/contents/${encodeURI(path)}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `${String(args.commit_message).slice(0, 200)}\n\nvia Artivio Command Center`,
          content: Buffer.from(content, 'utf8').toString('base64'),
          sha: current.sha,
          branch: site.branch,
        }),
      });
      return `Committed ${body.commit?.sha?.slice(0, 7)} to ${site.owner}/${site.repo}@${site.branch}. Railway will auto-deploy in a few minutes. ${body.commit?.html_url ?? ''}`;
    },
  },
  {
    name: 'create_file',
    description: 'Create a new file (e.g. a new page) and commit to the site\'s deploy branch. Triggers auto-deploy.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
        commit_message: { type: 'string' },
      },
      required: ['site', 'path', 'content', 'commit_message'],
    },
    run: async (args) => {
      const site = resolveSite(args.site);
      const path = safePath(args.path);
      const content = String(args.content ?? '');
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
        throw new Error(`Content too large (limit ${MAX_FILE_BYTES} bytes).`);
      }
      const body = await gh(`/repos/${site.owner}/${site.repo}/contents/${encodeURI(path)}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `${String(args.commit_message).slice(0, 200)}\n\nvia Artivio Command Center`,
          content: Buffer.from(content, 'utf8').toString('base64'),
          branch: site.branch,
        }),
      });
      return `Created ${path} (commit ${body.commit?.sha?.slice(0, 7)}) on ${site.owner}/${site.repo}@${site.branch}. Railway will auto-deploy. ${body.commit?.html_url ?? ''}`;
    },
  },
  {
    name: 'recent_commits',
    description: 'Show the latest commits on a site\'s deploy branch (to verify an edit landed or review recent changes).',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['site'],
    },
    run: async (args) => {
      const site = resolveSite(args.site);
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
      const body = await gh(`/repos/${site.owner}/${site.repo}/commits?sha=${site.branch}&per_page=${limit}`);
      return JSON.stringify(body.map(c => ({ sha: c.sha.slice(0, 7), message: c.commit?.message?.split('\n')[0], date: c.commit?.committer?.date })));
    },
  },
];

// ── MCP protocol (JSON-RPC 2.0 over HTTP POST) ───────────────────────────────

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, message, code = -32000) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpc(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'artivio-mcp-sites', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || String(method).startsWith('notifications/')) {
    return null; // notifications get no response
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, {
      tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find(t => t.name === params?.name);
    if (!tool) {
      return rpcError(id, `Unknown tool: ${params?.name}`);
    }
    try {
      const text = await tool.run(params?.arguments || {});
      return rpcResult(id, { content: [{ type: 'text', text: String(text).slice(0, 100_000) }] });
    } catch (err) {
      return rpcResult(id, { content: [{ type: 'text', text: err?.message || 'Tool failed' }], isError: true });
    }
  }
  return rpcError(id, `Method not supported: ${method}`, -32601);
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sites: Object.keys(sites()).length, githubToken: Boolean(GITHUB_TOKEN) }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }

  const auth = req.headers.authorization || '';
  if (!API_KEY || auth !== `Bearer ${API_KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 2_000_000) {
      req.destroy();
    }
  });
  req.on('end', async () => {
    try {
      const msg = JSON.parse(raw);
      const reply = await handleRpc(msg);
      if (reply === null) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, 'Parse error', -32700)));
    }
  });
});

server.listen(PORT, () => {
  console.log(`artivio-mcp-sites listening on :${PORT} · sites: ${Object.keys(sites()).join(', ') || '(none configured)'}`);
});
