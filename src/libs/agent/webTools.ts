/**
 * Web reading — `fetch_url`, always available to the agent in every workspace.
 *
 * A plain HTTP fetch: no JavaScript, no browser, no cost. That covers most of
 * what the agent actually needs — blogs, docs, RSS, JSON APIs, competitor copy,
 * and verifying a page it just published (server-rendered sites like WordPress
 * and Duda read fine).
 *
 * DELIBERATELY NOT HERE (2026-07-13 decision):
 *  · Self-hosted Browserless — a Chromium binary on Railway costs money, eats
 *    memory, and its datacenter IP gets blocked by exactly the sites that need a
 *    real browser. It solved nothing we couldn't do with fetch, so it's gone.
 *  · JS rendering / anti-bot scraping — when fetch_url can't read a page, the
 *    answer is a hosted MCP registered in the Tools panel (Firecrawl for
 *    extraction, Bright Data for hard targets), NOT platform infrastructure.
 *    Zero code here, and the cost lands on the workspace that needs it.
 */

import type { PlatformExecutor } from '@/libs/agent/platformTools';
import type { AnthropicTool } from '@/libs/mcp/registry';

const MAX_CHARS = 40_000;

/**
 * SSRF guard. The agent picks these URLs — sometimes from untrusted page
 * content — and it runs inside Railway's private network next to Postgres.
 * Public http(s) only: no localhost, no RFC1918, no cloud metadata endpoint.
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
  const isLoopback = host === 'localhost' || host === '::1' || host === '[::1]';
  const isInternalName = host.endsWith('.internal') || host.endsWith('.local');
  const isPrivateIp = /^(?:10|127|0)\./.test(host)
    || /^169\.254\./.test(host) // cloud metadata
    || /^192\.168\./.test(host)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host);

  if (isLoopback || isInternalName || isPrivateIp) {
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

export function buildWebTools(): {
  anthropicTools: AnthropicTool[];
  executors: Map<string, PlatformExecutor>;
} {
  const executors = new Map<string, PlatformExecutor>();

  const anthropicTools: AnthropicTool[] = [
    {
      name: 'fetch_url',
      description: 'Fetch a web page or API and return its text. Fast and free, but it does NOT run JavaScript. If the result comes back empty, or is a shell that says "enable JavaScript", the page is client-rendered and this tool cannot read it — say so and recommend connecting a scraping MCP (e.g. Firecrawl) in the Tools panel rather than guessing at the content.',
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  ];

  executors.set('fetch_url', {
    policy: 'auto', // read-only
    call: async (args) => {
      const url = assertPublicUrl(String(args.url ?? ''));
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'ArtivioBot/1.0 (+https://artivio.ai)' },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await resp.text();
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching ${url.hostname}.`);
      }

      const type = resp.headers.get('content-type') ?? '';
      const isHtml = type.includes('html');
      const content = isHtml ? htmlToText(body) : body;

      return JSON.stringify({
        url: url.toString(),
        title: isHtml ? titleOf(body) : undefined,
        content: content.slice(0, MAX_CHARS),
        truncated: content.length > MAX_CHARS,
        ...(isHtml && content.length < 200
          ? { note: 'Almost no text came back — this page is probably client-rendered and needs a scraping MCP to read.' }
          : {}),
      });
    },
  });

  return { anthropicTools, executors };
}
