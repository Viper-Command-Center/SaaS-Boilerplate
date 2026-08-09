/**
 * Per-tenant rate limiting for agent-facing routes (Phase 27 / P0, UAT E8).
 *
 * Fixed-window counter, in-memory. That is a DELIBERATE fit for the current
 * deployment: one Railway container, so one process owns the counters. If the
 * app ever scales horizontally, move this to Postgres (a counters table with
 * upsert) — do NOT keep the Map and call it done, because each replica would
 * enforce its own window and the real limit becomes limit × replicas.
 *
 * What this protects against: a runaway client loop (or a stuck automation)
 * hammering /api/agent/chat. Each turn can cost dozens of model calls, so a
 * tight-loop client is a money problem long before it is a load problem. The
 * spend cap is the ceiling on dollars; this is the ceiling on VELOCITY, and it
 * answers in seconds instead of after the budget is gone.
 */

const WINDOW_MS = 60_000;
/**
 * Agent turns per tenant per minute. Generous for humans (a turn takes
 * 10-60s anyway); tight for loops.
 */
const MAX_TURNS_PER_WINDOW = 10;

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/** Bound stale entries so a long-lived process doesn't grow forever. */
const MAX_BUCKETS = 5_000;

export type RateDecision
  = | { allowed: true }
    | { allowed: false; retryAfterSec: number };

export function checkRateLimit(tenantId: string, key = 'chat'): RateDecision {
  const now = Date.now();
  const mapKey = `${tenantId}:${key}`;
  const bucket = buckets.get(mapKey);

  if (!bucket || now >= bucket.resetAt) {
    if (buckets.size >= MAX_BUCKETS) {
      // Cheap pressure valve: drop expired entries first.
      for (const [k, b] of buckets) {
        if (now >= b.resetAt) {
          buckets.delete(k);
        }
      }
    }
    buckets.set(mapKey, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }

  if (bucket.count < MAX_TURNS_PER_WINDOW) {
    bucket.count += 1;
    return { allowed: true };
  }

  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}
