/**
 * Operator playbooks (Phase 37).
 *
 * Three layers of "what an agent knows about a tool":
 *   1. BuiltinProvider.guidance — shipped with the adapter, tested by
 *      tripwires, deploy-gated. The floor.
 *   2. Playbooks (this file) — platform-wide notes the operator edits in
 *      Admin → Playbooks, live on the next turn, no deploy. Scoped to a
 *      provider so a WordPress rule reaches every workspace with WordPress
 *      Sites enabled and nobody else.
 *   3. Workspace memory / file library — client-specific facts.
 *
 * Why: Noah (2026-09-07) guessed an Oxygen ability name and reported "the MCP
 * is offline". The rule that fixes that belongs to EVERY workspace using
 * WordPress, and Ryan should be able to write it tonight, not wait for a deploy.
 */

import { eq, inArray } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { playbooks } from '@/models/Schema';

export const PLAYBOOK_ALL = '*';
export const MAX_PLAYBOOK_BODY = 12_000;
export const MAX_HISTORY = 20;

export type PlaybookRow = typeof playbooks.$inferSelect;

/** Scopes a playbook may carry: "*", a built-in slug, or "stdio:<key>". */
export const SCOPE_RE = /^(?:\*|[a-z0-9][a-z0-9-]{1,60}|stdio:[a-z0-9][a-z0-9-]{1,60})$/;

/**
 * Which playbooks apply to a workspace whose enabled providers are `scopes`
 * (the keys of the registry's guidanceByProvider map: built-in slugs and
 * `stdio:<key>`). Pure, so it is testable without a database.
 */
export function selectPlaybooks<T extends { scope: string; enabled: boolean }>(rows: T[], scopes: Iterable<string>): T[] {
  const set = new Set(scopes);
  return rows.filter(r => r.enabled && (r.scope === PLAYBOOK_ALL || set.has(r.scope)));
}

/** Render the applicable playbooks as one system-prompt section (empty string when none). */
export function renderPlaybooks(rows: Array<{ scope: string; title: string; body: string }>): string {
  if (rows.length === 0) {
    return '';
  }
  const parts = rows.map(r => `### ${r.title}${r.scope === PLAYBOOK_ALL ? '' : ` (${r.scope})`}\n${r.body.trim()}`);
  return `## Operator playbooks (standing rules set by the platform operator — follow them)\n${parts.join('\n\n')}`;
}

/** Load the enabled playbooks for these provider scopes. Never throws — a playbook outage must not take chat down. */
export async function loadPlaybooksFor(scopes: Iterable<string>): Promise<string> {
  const wanted = [PLAYBOOK_ALL, ...new Set(scopes)];
  try {
    const rows = await db
      .select({ scope: playbooks.scope, title: playbooks.title, body: playbooks.body, enabled: playbooks.enabled, updatedAt: playbooks.updatedAt })
      .from(playbooks)
      .where(inArray(playbooks.scope, wanted));
    const chosen = selectPlaybooks(rows, wanted).sort((a, b) => (a.scope === PLAYBOOK_ALL ? -1 : b.scope === PLAYBOOK_ALL ? 1 : a.title.localeCompare(b.title)));
    return renderPlaybooks(chosen);
  } catch (err) {
    console.error(`[playbooks] load failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    return '';
  }
}

export async function listPlaybooks(): Promise<PlaybookRow[]> {
  return db.select().from(playbooks).orderBy(playbooks.scope, playbooks.title);
}

export async function getPlaybook(id: string): Promise<PlaybookRow | undefined> {
  const [row] = await db.select().from(playbooks).where(eq(playbooks.id, id)).limit(1);
  return row;
}
