/**
 * Per-site activity (§7). Every channel call is logged: workspace, site,
 * channel, tool, an ARG HASH (never the arguments — they can carry content
 * the client did not agree to keep), status, duration. Surfaced per site as
 * "Activity" in the Sites panel for client transparency.
 */

import { createHash } from 'node:crypto';
import { and, desc, eq, like } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { auditLog } from '@/models/Schema';

export const WP_SITE_ACTION = 'wp_site.call';

export function hashArgs(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex').slice(0, 16);
}

export async function logSiteCall(input: {
  tenantId: string;
  siteId: string;
  label: string;
  channel: 'rest' | 'mcp' | 'cli' | 'meta';
  tool: string;
  args: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
}): Promise<void> {
  await db.insert(auditLog).values({
    tenantId: input.tenantId,
    actor: 'agent',
    action: WP_SITE_ACTION,
    target: input.siteId,
    detail: {
      label: input.label,
      channel: input.channel,
      tool: input.tool,
      argHash: hashArgs(input.args),
      ok: input.ok,
      ms: input.durationMs,
      ...(input.error ? { error: input.error.slice(0, 300) } : {}),
    },
  }).catch(() => {});
}

export type ActivityRow = { at: string; actor: string; action: string; detail: Record<string, unknown> };

export async function listSiteActivity(tenantId: string, siteId: string, limit = 50): Promise<ActivityRow[]> {
  const rows = await db
    .select({ at: auditLog.at, actor: auditLog.actor, action: auditLog.action, detail: auditLog.detail })
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.target, siteId), like(auditLog.action, 'wp_site.%')))
    .orderBy(desc(auditLog.at))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(r => ({ at: r.at.toISOString(), actor: r.actor, action: r.action, detail: (r.detail ?? {}) as Record<string, unknown> }));
}

/** Non-call events (test, rotate, edit) from the UI — same target, so they show in Activity. */
export async function logSiteEvent(tenantId: string, siteId: string, actor: string, event: 'test' | 'rotate' | 'create' | 'update' | 'delete' | 'import', detail: Record<string, unknown> = {}): Promise<void> {
  await db.insert(auditLog).values({
    tenantId,
    actor,
    action: `wp_site.${event}`,
    target: siteId,
    detail,
  }).catch(() => {});
}
