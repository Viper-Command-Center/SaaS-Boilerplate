/**
 * In-memory registry of live agent turns, keyed by conversationId (Phase 29).
 *
 * Same DELIBERATE single-container fit as rateLimit.ts: one Railway container,
 * so one process owns the map. If the app ever scales horizontally, move this
 * to a shared store (Postgres/Redis) — do NOT keep the Map and call it done,
 * because a Stop request landing on a different replica than the one running
 * the turn would silently no-op.
 *
 * Why this exists: /api/agent/chat used to treat ANY client disconnect as Stop
 * (the stream's cancel() set a flag the loop read). A page REFRESH aborts the
 * stream, so a user refreshing to check on a long task was silently KILLING the
 * run. This registry makes Stop an EXPLICIT signal (POST /api/agent/stop sets
 * stopRequested) and makes disconnect harmless — the handler keeps running and
 * persists the message via its finally block, and a refreshed page picks the
 * live turn back up via GET /api/agent/status.
 */

export type ActiveTurn = {
  tenantId: string;
  startedAt: number;
  iteration: number;
  lastTool: string | null;
  stopRequested: boolean;
};

const turns = new Map<string /* conversationId */, ActiveTurn>();

/** Leak guard: cap the map and evict the oldest turn once we exceed it. */
const MAX_TURNS = 500;

export function beginTurn(conversationId: string, tenantId: string): void {
  if (turns.size >= MAX_TURNS && !turns.has(conversationId)) {
    // Evict the oldest entry (insertion order is preserved by Map).
    const oldest = turns.keys().next().value;
    if (oldest !== undefined) {
      turns.delete(oldest);
    }
  }
  turns.set(conversationId, {
    tenantId,
    startedAt: Date.now(),
    iteration: 0,
    lastTool: null,
    stopRequested: false,
  });
}

export function noteProgress(conversationId: string, iteration: number, lastTool: string | null): void {
  const turn = turns.get(conversationId);
  if (turn) {
    turn.iteration = iteration;
    turn.lastTool = lastTool;
  }
}

/** Request a stop. Returns false when there is no active turn to stop. */
export function requestStop(conversationId: string): boolean {
  const turn = turns.get(conversationId);
  if (!turn) {
    return false;
  }
  turn.stopRequested = true;
  return true;
}

export function isStopRequested(conversationId: string): boolean {
  return turns.get(conversationId)?.stopRequested ?? false;
}

export function getTurn(conversationId: string): ActiveTurn | null {
  return turns.get(conversationId) ?? null;
}

export function endTurn(conversationId: string): void {
  turns.delete(conversationId);
}
