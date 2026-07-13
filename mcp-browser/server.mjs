/**
 * Artivio mcp-browser — built-in web browsing MCP (zero dependencies).
 *
 * Thin MCP wrapper around a self-hosted Browserless instance (its own Railway
 * service, private networking). Gives every workspace agent JS-rendered
 * browsing at flat compute cost. Premium alternatives (Firecrawl, Browserbase,
 * Hyperbrowser MCPs) can be added per-workspace in the Tools panel when more
 * scale/stealth is needed.
 *
 * Env:
 *   PORT               — provided by Railway
 *   MCP_API_KEY        — bearer token clients must send
 *   BROWSERLESS_URL    — e.g. http://browserless.railway.internal:3000
 *   BROWSERLESS_TOKEN  — Browserless TOKEN env value
 *
 * Note: self-hosted browsing runs from datacenter IPs — heavily bot-protected
 * sites may block it; that's what the premium MCPs are for.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT) || 8080;
const API_KEY = process.env.MCP_API_KEY || '';
const BROWSERLESS_URL = (process.env.BROWSERLESS_URL || '').replace(/\/$/, '');
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '';
const MAX_TEXT = 40_000;

function assertHttpUrl(u) {
  let url;
  try {
    url = new URL(String(u));
  } catch {
    throw new Error('Invalid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed.');
  }
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local')
    || /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) {
    throw new Error('Internal addresses are not allowed.');
  }
  return url.toString();
}

async function browserless(path, payload) {
  if (!BROWSERLESS_URL) {
    throw new Error('BROWSERLESS_URL is not configured on this service.');
  }
  const resp = await fetch(`${BROWSERLESS_URL}${path}?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 200);
    throw new Error(`Browser backend ${resp.status}: ${detail}`);
  }
  return resp;
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, '\'')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < 40) {
    try {
      const href = new URL(m[1], baseUrl).toString();
      const text = htmlToText(m[2]).slice(0, 80);
      if (text && href.startsWith('http')) {
        links.push({ text, href });
      }
    } catch { /* skip bad hrefs */ }
  }
  return links;
}

const TOOLS = [
  {
    name: 'browse_page',
    description: 'Load a URL in a real headless browser (JavaScript rendered) and return the page title, readable text content, and main links. Your default tool for reading any web page.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        wait_ms: { type: 'number', description: 'Extra wait after load for JS-heavy pages (max 10000)' },
      },
      required: ['url'],
    },
    run: async (args) => {
      const url = assertHttpUrl(args.url);
      const waitMs = Math.min(Math.max(Number(args.wait_ms) || 0, 0), 10_000);
      const resp = await browserless('/content', {
        url,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 45_000 },
        ...(waitMs ? { waitForTimeout: waitMs } : {}),
      });
      const html = await resp.text();
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
      const text = htmlToText(html).slice(0, MAX_TEXT);
      const links = extractLinks(html, url);
      return JSON.stringify({ url, title, text, links });
    },
  },
  {
    name: 'get_page_html',
    description: 'Load a URL and return its rendered raw HTML (truncated). Use when you need markup structure rather than readable text.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    run: async (args) => {
      const url = assertHttpUrl(args.url);
      const resp = await browserless('/content', { url, gotoOptions: { waitUntil: 'networkidle2', timeout: 45_000 } });
      const html = await resp.text();
      return html.slice(0, 60_000);
    },
  },
  {
    name: 'scrape_page',
    description: 'Load a URL and extract the text of specific CSS selectors (e.g. ".price", "h1", "article a"). Precise and cheap for structured pages.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        selectors: { type: 'array', items: { type: 'string' }, description: 'CSS selectors to extract' },
      },
      required: ['url', 'selectors'],
    },
    run: async (args) => {
      const url = assertHttpUrl(args.url);
      const selectors = (Array.isArray(args.selectors) ? args.selectors : []).slice(0, 10).map(String);
      if (selectors.length === 0) {
        throw new Error('Provide at least one CSS selector.');
      }
      const resp = await browserless('/scrape', {
        url,
        elements: selectors.map(selector => ({ selector })),
        gotoOptions: { waitUntil: 'networkidle2', timeout: 45_000 },
      });
      const data = await resp.json();
      const out = {};
      for (const el of data.data ?? []) {
        out[el.selector] = (el.results ?? []).slice(0, 25).map(r => String(r.text ?? '').trim()).filter(Boolean);
      }
      return JSON.stringify(out).slice(0, MAX_TEXT);
    },
  },
];

// ── MCP protocol (same scaffolding as mcp-sites) ─────────────────────────────

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
      serverInfo: { name: 'artivio-mcp-browser', version: '1.0.0' },
    });
  }
  if (String(method).startsWith('notifications/')) {
    return null;
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
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
    res.end(JSON.stringify({ ok: true, backend: Boolean(BROWSERLESS_URL) }));
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
    if (raw.length > 1_000_000) {
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
  console.log(`artivio-mcp-browser listening on :${PORT} · backend: ${BROWSERLESS_URL || '(not configured)'}`);
});
