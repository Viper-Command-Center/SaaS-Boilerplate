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
import { browserConfigured, inspectLayout, renderPage } from '@/libs/browser/agentcore';

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
    {
      name: 'check_layout',
      description: 'Measure how a live page actually RENDERS, at desktop, tablet and mobile widths in one pass. Reports objective layout defects — a headline whose last line is a single orphaned word, text overflowing its box, a page that scrolls sideways on mobile, text too small to read — plus the real font size and line count of each heading. Use this AFTER changing page copy or styling, and BEFORE telling anyone a layout change worked: none of it is visible in a page tree, because it is only true once a browser has laid the text out. Returns compact JSON, not an image.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The live page URL.' },
          widths: {
            type: 'array',
            items: { type: 'number' },
            description: 'Viewport widths in px. Default [1440, 768, 390] — desktop, tablet, phone. Max 4.',
          },
          selectors: {
            type: 'array',
            items: { type: 'string' },
            description: 'CSS selectors to measure. Defaults to headings and buttons, which is what usually breaks.',
          },
          wait_ms: { type: 'number', description: 'Render wait before measuring (default 3000, max 15000).' },
        },
        required: ['url'],
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

    if (tool === 'check_layout') {
      const report = await inspectLayout({
        url,
        widths: Array.isArray(args.widths) ? args.widths.map(Number).filter(n => Number.isFinite(n)) : undefined,
        selectors: Array.isArray(args.selectors) ? args.selectors.map(String) : undefined,
        waitMs: Number(args.wait_ms) || undefined,
      });

      const issueCount = report.viewports.reduce((n, v) => n + v.issues.length, 0);

      return {
        output: JSON.stringify({
          url: report.url,
          title: report.title,
          issueCount,
          viewports: report.viewports,
          verdict: issueCount === 0
            ? 'No layout defects found at the widths checked.'
            : `${issueCount} layout issue(s) found. A "widow" means the element wraps and its final line holds one lonely word — usually fixed by a small font-size reduction, shorter copy, or a non-breaking space joining the last two words (which, unlike a fixed font size, holds at every width).`,
          note: 'Measured in a real browser after layout. These are computed facts about rendered line boxes, not opinions — and they are invisible in the page tree.',
        }),
        units: report.sessionSeconds,
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
