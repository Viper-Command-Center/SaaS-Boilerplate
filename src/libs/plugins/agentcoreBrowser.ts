/**
 * AgentCore Browser — built-in tier-1 provider.
 *
 * Registered as a plugin (rather than a free platform tool) for one reason:
 * it costs real money per session-second, so it must flow through the same
 * metering, markup and spend-cap machinery as Kie.ai. Usage-metered — the
 * adapter reports the seconds each session was actually alive, so a 4-second
 * page read and a 90-second form flow are billed correctly.
 *
 * Credential: none of its own. It authenticates with the platform's AWS keys
 * (the same ones Bedrock already uses), so there is nothing for anyone to paste.
 */

import type { BuiltinProvider } from '@/libs/plugins/types';
import { browserConfigured, renderPage } from '@/libs/browser/agentcore';

/** $/second. AgentCore bills ~$0.0895/vCPU-hr + $0.00945/GB-hr → ≈$0.11/hr. */
export const BROWSER_USD_PER_SECOND = 0.11 / 3600;

export const agentcoreBrowserProvider: BuiltinProvider = {
  slug: 'agentcore-browser',
  name: 'Cloud browser (AWS AgentCore)',
  description: 'A real Chrome running in AWS. Reads JavaScript-rendered pages that a plain fetch cannot see, and can operate web apps that have no API. Sessions are recorded for audit.',
  credentialLabel: 'None — uses the platform AWS credentials already configured for Bedrock.',
  noCredential: true,
  usageMetering: {
    unitLabel: 'browser-second',
    defaultUnitCostUsd: BROWSER_USD_PER_SECOND,
    note: 'AgentCore bills per session-second (~$0.11/hour). The adapter reports exactly how long each session was alive, so short page reads cost fractions of a cent.',
  },

  tools: [
    {
      name: 'browse_page',
      description: 'Load a page in a REAL browser (JavaScript executed) and return its rendered text. Use this when fetch_url comes back empty or looks like a shell — i.e. the site is client-rendered. Slower and costs money, so prefer fetch_url first.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          wait_ms: { type: 'number', description: 'How long to let the page render before reading it (default 3000, max 15000).' },
        },
        required: ['url'],
      },
    },
    {
      name: 'scrape_page',
      description: 'Extract structured data from a JavaScript-rendered page by CSS selector, using a real browser. Returns the matched elements\' text. Use for price lists, product grids, dashboards.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          selectors: {
            type: 'array',
            items: { type: 'string' },
            description: 'CSS selectors, e.g. ["h1", ".product-card .price"]',
          },
          wait_ms: { type: 'number' },
        },
        required: ['url', 'selectors'],
      },
    },
  ],

  call: async (tool, args) => {
    if (!browserConfigured()) {
      throw new Error('The cloud browser needs AWS credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) configured on the platform.');
    }

    const url = String(args.url ?? '');
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('Give a full http(s) URL.');
    }

    if (tool === 'browse_page') {
      const page = await renderPage({ url, waitMs: Number(args.wait_ms) || undefined });
      return {
        output: JSON.stringify({
          url: page.url,
          title: page.title,
          content: page.text,
          renderedWith: 'AgentCore browser (JavaScript executed)',
        }),
        // Bill the seconds the session was actually alive.
        units: page.sessionSeconds,
      };
    }

    if (tool === 'scrape_page') {
      const selectors = (Array.isArray(args.selectors) ? args.selectors : []).map(String).slice(0, 10);
      if (selectors.length === 0) {
        throw new Error('Give at least one CSS selector.');
      }
      const page = await renderPage({ url, waitMs: Number(args.wait_ms) || undefined, selectors });
      return {
        output: JSON.stringify({ url: page.url, title: page.title, results: page.text }),
        units: page.sessionSeconds,
      };
    }

    throw new Error(`Unknown browser tool: ${tool}`);
  },
};
