/**
 * Web reading — the agent's eyes on the open internet.
 *
 * Two tiers, and the agent gets whichever exist:
 *
 *  1. `fetch_url` — a plain HTTP fetch. No JavaScript, no browser. Free, instant,
 *     and enough for most blogs, docs, RSS, JSON APIs and competitor copy.
 *     ALWAYS available.
 *
 *  2. `browse_page` / `scrape_page` — a REAL browser (self-hosted Browserless on
 *     Railway) that executes JavaScript. Needed for React/SPA sites, anything
 *     behind a client-side render, and structured scraping by CSS selector.
 *     Only registered when BROWSERLESS_URL is configured, so the platform works
 *     without it.
 *
 * Per the architecture rule: Browserless runs as its own Railway service (it's a
 * browser binary — nothing else is), and we call its REST API directly. No MCP
 * wrapper service in between.
 *
 * Env:
 *   BROWSERLESS_URL    http://browserless.railway.internal:3000  (private network)
 *   BROWSERLESS_TOKEN  the TOKEN you set on that service
 */

import type { AnthropicTool } from '@/libs/mcp/registry';
import type { PlatformExecutor } from '@/libs/agent/platformTools';

const MAX_CHARS = 40_000;
const TIMEOUT_MS = 45_000;

export function browserConfigured(): boolean {
  return Boolean(process.env.BROWSERLESS_URL);
}

/**
 * SSRF guard. The agent picks these URLs, sometimes from untrusted page content,
 * and it runs inside Railway's private network next to Postgres and the browser
 * service. Public http(s) only — no localhost, no RFC1918, no metadata endpoints.
 */
function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs can be fetched.');
  }
  const host = url.hostname.toLowerCase();

  const isLoopbackName = host === 'localhost' || host === '::1' || host === '[::1]';
  const isInternalName = host.endsWith('.internal') || host.endsWith('.local');
  // Private / link-local / loopback IPv4 ranges (169.254.169.254 = cloud metadata).
  const isPrivateIp = /^(?:10|127|0)\./.test(host)
    || /^169\.254\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host);

  if (isLoopbackName || isInternalName || isPrivateIp) {
    throw new Error('That host is not reachable from here.');
  }
  return url;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function titleOf(html: string): string {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
}

async function browserless(path: string, body: unknown): Promise<string> {
  const base = (process.env.BROWSERLESS_URL ?? '').replace(/\/$/, '');
  const token = process.env.BROWSERLESS_TOKEN ?? '';
  const resp = await fetch(`${base}${path}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Browser service error (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  return text;
}

export function buildWebTools(): {
  anthropicTools: AnthropicTool[];
  executors: Map<string, PlatformExecutor>;
} {
  const anthropicTools: AnthropicTool[] = [];
  const executors = new Map<string, PlatformExecutor>();

  // ── Tier 1: plain fetch (always) ──────────────────────────────────────────
  anthropicTools.push({
    name: 'fetch_url',
    description: 'Fetch a web page or API and return its text. Fast and free, but it does NOT run JavaScript — if the result looks empty, or is a shell that says "enable JavaScript", the page is client-rendered: use browse_page instead (when available).',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  });

  executors.set('fetch_url', {
    policy: 'auto', // read-only
    call: async (args) => {
      const url = assertPublicUrl(String(args.url ?? ''));
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'ArtivioBot/1.0 (+https://artivio.ai)' },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await resp.text();
      const type = resp.headers.get('content-type') ?? '';
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching ${url.hostname}.`);
      }
      const out = type.includes('html') ? htmlToText(body) : body;
      return JSON.stringify({
        url: url.toString(),
        title: type.includes('html') ? titleOf(body) : undefined,
        content: out.slice(0, MAX_CHARS),
        truncated: out.length > MAX_CHARS,
      });
    },
  });

  // ── Tier 2: real browser (only when the service exists) ───────────────────
  if (!browserConfigured()) {
    return { anthropicTools, executors };
  }

  anthropicTools.push(
    {
      name: 'browse_page',
      description: 'Load a page in a REAL browser (JavaScript executed) and return its rendered text. Use for SPAs, dashboards, and anything fetch_url returns empty for.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          wait_for: { type: 'string', description: 'Optional CSS selector to wait for before reading.' },
        },
        required: ['url'],
      },
    },
    {
      name: 'scrape_page',
      description: 'Extract structured data from a page by CSS selector, in a real browser. Returns the matched elements\' text. Use for price lists, competitor product grids, search results.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          selectors: {
            type: 'array',
            items: { type: 'string' },
            description: 'CSS selectors, e.g. ["h1", ".product-card .price"]',
          },
        },
        required: ['url', 'selectors'],
      },
    },
  );

  executors.set('browse_page', {
    policy: 'auto',
    call: async (args) => {
      const url = assertPublicUrl(String(args.url ?? ''));
      const html = await browserless('/content', {
        url: url.toString(),
        ...(args.wait_for ? { waitForSelector: { selector: String(args.wait_for), timeout: 15_000 } } : {}),
        gotoOptions: { waitUntil: 'networkidle2', timeout: 30_000 },
      });
      const text = htmlToText(html);
      return JSON.stringify({
        url: url.toString(),
        title: titleOf(html),
        content: text.slice(0, MAX_CHARS),
        truncated: text.length > MAX_CHARS,
      });
    },
  });

  executors.set('scrape_page', {
    policy: 'auto',
    call: async (args) => {
      const url = assertPublicUrl(String(args.url ?? ''));
      const selectors = (Array.isArray(args.selectors) ? args.selectors : [])
        .map(String)
        .slice(0, 10);
      if (selectors.length === 0) {
        throw new Error('Give at least one CSS selector.');
      }
      const raw = await browserless('/scrape', {
        url: url.toString(),
        elements: selectors.map(selector => ({ selector })),
        gotoOptions: { waitUntil: 'networkidle2', timeout: 30_000 },
      });
      return raw.slice(0, MAX_CHARS);
    },
  });

  return { anthropicTools, executors };
}
