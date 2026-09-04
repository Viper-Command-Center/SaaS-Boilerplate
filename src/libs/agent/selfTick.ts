/**
 * selfTick.ts (2026-09-04) — the app ticks its own mission/task runner.
 *
 * Why: the runner was triggered ONLY by a GitHub Actions cron declared as
 * "every 10 minutes". GitHub does not honour that on this repo — the Actions
 * history shows scheduled runs landing every 1–2 HOURS (9:22 PM, 7:40 PM,
 * 5:54 PM, 3:47 PM, 3:08 PM…), all green. So the runner was healthy and a
 * new mission still sat at 0/6 for twenty minutes: nothing was calling it.
 * GitHub documents that schedules are delayed under load and deprioritised
 * for public/forked repos; nothing in the workflow file changes that.
 *
 * Railway runs Artivio as a long-lived Node server, so the server can call
 * its own /api/internal/run-scheduled every TICK_MS. The GitHub workflow
 * stays as a backup and as the externally visible heartbeat — the runner is
 * overlap-safe by design (tasks claim via nextRunAt, steps via status +
 * staleness), so both firing is fine.
 *
 * Single-process assumption, same as runnerHealth.ts / rateLimit.ts: one
 * container, one interval. If Railway ever runs replicas, set
 * SELF_TICK_ENABLED=false on all but one, or move the tick to a Railway cron.
 *
 * Wired from src/instrumentation.ts (`register()`, nodejs runtime only) —
 * Next 16 runs that once per server boot, which is exactly the lifetime an
 * interval should have.
 */

const TICK_MS = 10 * 60_000;
const FIRST_TICK_DELAY_MS = 90_000; // let the server finish booting first

let started = false;

export function startSelfTick(): void {
  if (started) {
    return;
  }
  if (process.env.SELF_TICK_ENABLED === 'false') {
    console.warn('[self-tick] disabled by SELF_TICK_ENABLED=false');
    return;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    console.warn('[self-tick] CRON_SECRET missing or too short — self-tick NOT started; only GitHub Actions will tick the runner.');
    return;
  }
  started = true;

  const port = process.env.PORT || '3000';
  const url = process.env.SELF_TICK_URL || `http://127.0.0.1:${port}/api/internal/run-scheduled`;

  const tick = async () => {
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'x-cron-secret': secret },
        // The handler budgets itself to ~22 min; give it room but never hang forever.
        signal: AbortSignal.timeout(25 * 60_000),
      });
      const body = await res.text();
      const secs = Math.round((Date.now() - startedAt) / 1000);
      if (res.ok) {
        console.warn(`[self-tick] ${res.status} in ${secs}s: ${body.slice(0, 300)}`);
      } else {
        console.error(`[self-tick] HTTP ${res.status} in ${secs}s: ${body.slice(0, 300)}`);
      }
    } catch (err) {
      console.error(`[self-tick] failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const first = setTimeout(() => {
    void tick();
    const timer = setInterval(() => void tick(), TICK_MS);
    // Never keep the process alive just for this.
    timer.unref();
  }, FIRST_TICK_DELAY_MS);
  first.unref();

  console.warn(`[self-tick] started — first tick in ${FIRST_TICK_DELAY_MS / 1000}s, then every ${TICK_MS / 60_000} min → ${url}`);
}
