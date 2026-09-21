/**
 * Turn context (Phase 47) — who is running, in which conversation, right now.
 *
 * Tool executors are built once per toolset and know nothing about the turn
 * that invokes them. Some gates need exactly that: "has this conversation
 * looked up the Blurb map before writing a Blurb?", "how many page writes has
 * this turn made?". Rather than threading a context argument through every
 * executor signature, runToolLoop wraps each turn in an AsyncLocalStorage
 * scope and gates read it. Absent scope (unit tests, scripts) reads as
 * `null`, and gates must fail SAFE on null — refuse, never skip.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type TurnContext = {
  tenantId: string;
  conversationId: string;
  /** 'operator' — the workspace chat; 'site' — a site's own admin (Phase 46). */
  surface: 'operator' | 'site';
  /** Mutable per-turn counters gates can bump. */
  counters: Record<string, number>;
  /**
   * Aborted when the user presses Stop (Phase 47). Model requests read this
   * signal so an in-flight generation ends within a second instead of running
   * to completion; tool executors may read it too.
   */
  abort: AbortController;
};

const als = new AsyncLocalStorage<TurnContext>();

export function runWithTurnContext<T>(ctx: Omit<TurnContext, 'counters' | 'abort'>, fn: (turn: TurnContext) => Promise<T>): Promise<T> {
  const turn: TurnContext = { ...ctx, counters: {}, abort: new AbortController() };
  return als.run(turn, () => fn(turn));
}

/** The current turn's abort signal, or undefined outside a turn. */
export function turnSignal(): AbortSignal | undefined {
  return als.getStore()?.abort.signal;
}

/** True when the current turn was stopped by the user. */
export function turnAborted(): boolean {
  return als.getStore()?.abort.signal.aborted ?? false;
}

export function currentTurn(): TurnContext | null {
  return als.getStore() ?? null;
}

/** Increment a per-turn counter and return the new value (0-based store, 1 after first bump). */
export function bumpCounter(key: string): number {
  const t = als.getStore();
  if (!t) {
    return 0;
  }
  t.counters[key] = (t.counters[key] ?? 0) + 1;
  return t.counters[key]!;
}
