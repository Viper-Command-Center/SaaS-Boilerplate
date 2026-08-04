/**
 * runnerHealth.ts (Phase 29) — a heartbeat for the background mission/task
 * runner so the dashboard can tell an operator whether the cron is alive.
 *
 * The failure this guards: GitHub Actions can silently stop delivering the
 * /api/internal/run-scheduled tick (disabled workflow, expired secret, repo
 * archived). When that happens missions simply stop advancing with no error
 * anywhere the human can see — they look "stuck" but nothing is wrong with
 * the mission itself. run-scheduled calls markTick() on every invocation;
 * the Missions panel reads getLastTickAt() and shows "runner ticked Xm ago"
 * (green), "no tick in Xm — check GitHub Actions" (amber), or "no tick since
 * last deploy" (grey).
 *
 * Same single-process assumption as rateLimit.ts / activeTurns.ts: this is an
 * in-memory value on one container. It resets to null on every deploy — that
 * is fine and intentional, the UI says "no tick since last deploy" rather
 * than pretending to know across restarts.
 */

let lastTickAt: number | null = null;

/** Record that the scheduled runner just executed. Called at the top of the
 * run-scheduled handler, after auth. */
export function markTick(): void {
  lastTickAt = Date.now();
}

/** Epoch ms of the most recent runner tick since this container started, or
 * null if it has not ticked since the last deploy. */
export function getLastTickAt(): number | null {
  return lastTickAt;
}
