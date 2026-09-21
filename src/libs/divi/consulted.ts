/**
 * "Reference consulted" ledger (Phase 47).
 *
 * The write gate refuses a Divi module the conversation has not looked up in
 * `diviops_reference` — so the model cannot build a Blurb from memory and
 * hope. The reference tool records each successful module lookup here, keyed
 * by conversation; the gate asks before every write.
 *
 * In-memory on purpose (same single-container fit as activeTurns.ts): a
 * redeploy forgets, and the only consequence is one extra reference call.
 * Entries expire after CONSULT_TTL_MS so a conversation revived a week later
 * re-reads the map — the vendor bundle may have moved on.
 */

import { canonicalModuleName } from './moduleMap';

const CONSULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 2000;

const ledger = new Map<string, Map<string, number>>();

export function recordConsulted(conversationId: string, moduleName: string): void {
  if (!conversationId) {
    return;
  }
  if (ledger.size >= MAX_CONVERSATIONS && !ledger.has(conversationId)) {
    const oldest = ledger.keys().next().value;
    if (oldest !== undefined) {
      ledger.delete(oldest);
    }
  }
  const m = ledger.get(conversationId) ?? new Map<string, number>();
  m.set(canonicalModuleName(moduleName), Date.now());
  ledger.set(conversationId, m);
}

export function hasConsulted(conversationId: string, moduleName: string): boolean {
  const at = ledger.get(conversationId)?.get(canonicalModuleName(moduleName));
  return typeof at === 'number' && Date.now() - at < CONSULT_TTL_MS;
}

/** Modules from `names` the conversation has NOT looked up (canonical names). */
export function unconsulted(conversationId: string, names: Iterable<string>): string[] {
  const out: string[] = [];
  for (const n of names) {
    const c = canonicalModuleName(n);
    if (!hasConsulted(conversationId, c) && !out.includes(c)) {
      out.push(c);
    }
  }
  return out;
}

/** Test hook. */
export function resetConsulted(): void {
  ledger.clear();
}
