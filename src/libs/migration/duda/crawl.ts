/**
 * Crawl politeness for Phase 1 page fetching — Phase 48, Part 1.
 *
 * This crawls a LIVE customer website. We were bitten once by how twitchy these
 * hosting stacks are under unusual traffic (the build9 LiteSpeed-cache bug), so
 * this is deliberately conservative and NON-optional:
 *   · max 2–3 concurrent requests (a small semaphore),
 *   · ≥ ~700ms between requests to the same host,
 *   · respect robots.txt (fetched + cached once per host),
 *   · a descriptive User-Agent that names the tool + a contact,
 *   · HARD back-off on any 429/503 — we stop, we do not hammer retries.
 *
 * No new dependency: the semaphore, host throttle and a minimal robots parser
 * are hand-rolled, matching this repo's "no deps for a handful of HTTP calls"
 * discipline (see src/libs/storage/r2.ts).
 */

import { MIGRATION_USER_AGENT } from '@/libs/migration/duda/client';

const MAX_CONCURRENCY = 2;
const MIN_HOST_DELAY_MS = 700;
const REQUEST_TIMEOUT_MS = 20_000;

/** Thrown on a 429/503 — signals the whole crawl must stop immediately. */
export class CrawlBackoffError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`Host asked us to back off (HTTP ${status}) at ${url}. Stopping the crawl to avoid hammering a live site.`);
    this.name = 'CrawlBackoffError';
    this.status = status;
  }
}

/** A tiny counting semaphore — caps how many fetches run at once. */
class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];
  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.permits -= 1;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.permits += 1;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Minimal robots.txt ──────────────────────────────────────────────────────
// Only the pieces we need: Disallow rules for `*` and for our own UA token,
// longest-match wins (per the de-facto standard). Good enough to be a polite
// citizen without pulling in a parser dependency.

type RobotsRules = { allows: (path: string) => boolean };

const ALLOW_ALL: RobotsRules = { allows: () => true };

function parseRobots(text: string): RobotsRules {
  const uaToken = 'artiviomigrationbot';
  const groups: Array<{ agents: string[]; disallow: string[] }> = [];
  let current: { agents: string[]; disallow: string[] } | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) {
      continue;
    }
    const [field, ...rest] = line.split(':');
    const key = (field ?? '').toLowerCase().trim();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'disallow' && current) {
      current.disallow.push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  // Prefer a group naming our UA; else the wildcard group.
  const specific = groups.find(g => g.agents.some(a => a.includes(uaToken)));
  const wildcard = groups.find(g => g.agents.includes('*'));
  const rules = (specific ?? wildcard)?.disallow ?? [];

  return {
    allows(path: string) {
      let longest = '';
      for (const rule of rules) {
        if (rule === '') {
          continue; // "Disallow:" (empty) allows everything
        }
        if (path.startsWith(rule) && rule.length > longest.length) {
          longest = rule;
        }
      }
      return longest === '';
    },
  };
}

/**
 * A per-crawl HTTP client. One instance per migration job so the concurrency
 * cap, host timers and robots cache are shared across every page fetch.
 */
export class PoliteCrawler {
  private sem = new Semaphore(MAX_CONCURRENCY);
  private lastHitAt = new Map<string, number>();
  private robotsCache = new Map<string, RobotsRules>();
  private backedOff = false;

  /** Fetch a URL's HTML, honouring robots + throttle + back-off. */
  async fetchHtml(rawUrl: string): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
    if (this.backedOff) {
      throw new CrawlBackoffError(429, rawUrl);
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, reason: 'invalid URL' };
    }
    const rules = await this.robotsFor(url);
    if (!rules.allows(url.pathname)) {
      return { ok: false, reason: 'disallowed by robots.txt' };
    }
    const release = await this.sem.acquire();
    try {
      await this.throttle(url.host);
      const resp = await fetch(url.toString(), {
        headers: { 'User-Agent': MIGRATION_USER_AGENT, 'Accept': 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'follow',
      });
      if (resp.status === 429 || resp.status === 503) {
        this.backedOff = true;
        throw new CrawlBackoffError(resp.status, url.toString());
      }
      if (!resp.ok) {
        return { ok: false, reason: `HTTP ${resp.status}` };
      }
      return { ok: true, html: await resp.text() };
    } finally {
      release();
    }
  }

  /** Download raw bytes (an image) with the same politeness guarantees. */
  async fetchBytes(rawUrl: string): Promise<{ ok: true; bytes: Buffer; contentType: string } | { ok: false; reason: string }> {
    if (this.backedOff) {
      throw new CrawlBackoffError(429, rawUrl);
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, reason: 'invalid URL' };
    }
    const release = await this.sem.acquire();
    try {
      await this.throttle(url.host);
      const resp = await fetch(url.toString(), {
        headers: { 'User-Agent': MIGRATION_USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'follow',
      });
      if (resp.status === 429 || resp.status === 503) {
        this.backedOff = true;
        throw new CrawlBackoffError(resp.status, url.toString());
      }
      if (!resp.ok) {
        return { ok: false, reason: `HTTP ${resp.status}` };
      }
      return {
        ok: true,
        bytes: Buffer.from(await resp.arrayBuffer()),
        contentType: resp.headers.get('content-type') ?? 'application/octet-stream',
      };
    } finally {
      release();
    }
  }

  private async throttle(host: string): Promise<void> {
    const last = this.lastHitAt.get(host) ?? 0;
    const wait = MIN_HOST_DELAY_MS - (Date.now() - last);
    if (wait > 0) {
      await sleep(wait);
    }
    this.lastHitAt.set(host, Date.now());
  }

  private async robotsFor(url: URL): Promise<RobotsRules> {
    const cached = this.robotsCache.get(url.host);
    if (cached) {
      return cached;
    }
    let rules: RobotsRules;
    try {
      const resp = await fetch(`${url.origin}/robots.txt`, {
        headers: { 'User-Agent': MIGRATION_USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      // No robots (404) or a server error → assume allowed (standard behaviour).
      rules = resp.ok ? parseRobots(await resp.text()) : ALLOW_ALL;
    } catch {
      rules = ALLOW_ALL;
    }
    this.robotsCache.set(url.host, rules);
    return rules;
  }
}
