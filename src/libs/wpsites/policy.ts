/**
 * Per-site, per-channel execution policy (§1, §7) and the per-site write queue.
 *
 * The registry's policy model is per TOOL (auto | approval | deny). A site
 * policy is finer: the same `wp_rest` tool may be Auto-run on a staging site
 * and Ask-first on production. So the wp-sites provider resolves policy PER
 * CALL from the arguments (which site, which channel, read or write) and the
 * tool loop applies the result exactly as it applies a static policy.
 *
 * Reads never need approval on a channel that is not blocked — asking a human
 * to approve `wp option get blogname` trains them to click "approve" without
 * reading, which is the opposite of what approval is for.
 */

import type { ToolPolicy } from '@/libs/mcp/registry';
import type { Channel, SitePolicy } from '@/libs/wpsites/types';

export function toToolPolicy(site: SitePolicy, channel: Channel, isWrite: boolean): ToolPolicy {
  const v = site[channel];
  if (v === 'blocked') {
    return 'deny';
  }
  if (!isWrite) {
    return 'auto';
  }
  return v === 'auto' ? 'auto' : 'approval';
}

/** WP-CLI subcommands that only read. Anything not listed counts as a write. */
const CLI_READ_VERBS = new Set(['get', 'list', 'info', 'version', 'check', 'status', 'is-installed', 'is-active', 'path', 'exists', 'verify-checksums', 'search', 'pluck', 'count', 'meta get', 'meta list', 'term list', 'user list', 'option get', 'option list', 'option pluck']);

export function cliIsWrite(args: string[]): boolean {
  const words = args.filter(a => !a.startsWith('-'));
  if (words.length === 0) {
    return true;
  }
  if (words[0] === 'search-replace') {
    return !args.includes('--dry-run');
  }
  if (words[0] === 'cli' || words[0] === 'help') {
    return false;
  }
  const two = words.slice(0, 2).join(' ');
  if (CLI_READ_VERBS.has(two)) {
    return false;
  }
  const verb = words[1] ?? words[0] ?? '';
  return !CLI_READ_VERBS.has(verb);
}

export function restIsWrite(method: string): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

// ─── Per-site write serialisation ───────────────────────────────────────────
// Builder tree edits are not transactional; two concurrent writes to the same
// page interleave badly. Writes to one site run one at a time (in this
// process); reads never wait. Keyed by site id, so different sites proceed in
// parallel.

const chains = new Map<string, Promise<unknown>>();

export function serialisedForSite<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(siteId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(siteId, next);
  next.finally(() => {
    if (chains.get(siteId) === next) {
      chains.delete(siteId);
    }
  }).catch(() => {});
  return next;
}
