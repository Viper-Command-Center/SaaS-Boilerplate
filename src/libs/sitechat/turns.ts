/**
 * Site Chat turns (Phase 46) — run the pinned agent for a WordPress user.
 *
 * The plugin cannot hold a streaming connection open through PHP, so a turn is
 * ASYNC: POST starts it and answers 202; the plugin polls GET for the
 * transcript plus the live partial reply. The loop runs after the response
 * (next/server `after`), persists on finish, and the activeTurns registry +
 * a small live-text map give the poll something honest to show meanwhile.
 * Same principle as Phase 29: the run is never tied to a socket.
 */

import type { SiteChatContext, SiteChatUser } from '@/libs/sitechat/auth';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { beginTurn, endTurn, getTurn, isStopRequested, noteProgress } from '@/libs/agent/activeTurns';
import { runToolLoop } from '@/libs/agent/loop';
import { resolveAgentForTenant } from '@/libs/agent/persona';
import { db } from '@/libs/DB';
import { externalKeyFor } from '@/libs/sitechat/auth';
import { siteChatSystemPrompt } from '@/libs/sitechat/prompt';
import { buildSiteChatToolset } from '@/libs/sitechat/toolset';
import { conversations, messages } from '@/models/Schema';

const HISTORY_LIMIT = 30;
/** Site chats are for edits, not overnight builds. */
// Phase 47.1: a gated page build is ~4 reference reads + validate + write +
// render before any images; 16 ran out mid-build on the first live test.
const SITE_TURN_MAX_ITERATIONS = 28;
const SITE_TURN_WALL_CLOCK_MS = 6 * 60_000;

/** Partial reply text of a running turn, keyed by conversation id. */
const liveText = new Map<string, string>();

export async function findOrCreateSiteConversation(ctx: SiteChatContext, user: SiteChatUser) {
  const key = externalKeyFor(user);
  let [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.siteId, ctx.site.id), eq(conversations.externalKey, key), isNull(conversations.archivedAt)))
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  if (!conv) {
    [conv] = await db
      .insert(conversations)
      .values({ tenantId: ctx.tenant.id, siteId: ctx.site.id, externalKey: key, channel: 'site', title: `${ctx.site.label} · ${user.name}` })
      .returning();
  }
  if (!conv) {
    throw new Error('Could not open the conversation.');
  }
  return conv;
}

/**
 * "Start New Conversation": archive the speaker's current thread so the next
 * message opens a fresh one. Past threads stay in the DB (never deleted) —
 * there is no history browser in the plugin, this just stops the one thread
 * from being an infinite, never-reset transcript.
 */
export async function archiveSiteConversation(ctx: SiteChatContext, user: SiteChatUser): Promise<{ archived: boolean; reason?: string }> {
  const key = externalKeyFor(user);
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.siteId, ctx.site.id), eq(conversations.externalKey, key), isNull(conversations.archivedAt)))
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  if (!conv) {
    return { archived: true }; // nothing active — already "fresh"
  }
  if (getTurn(conv.id)) {
    return { archived: false, reason: 'The assistant is still working — wait for it to finish before starting a new conversation.' };
  }
  await db.update(conversations).set({ archivedAt: new Date() }).where(eq(conversations.id, conv.id));
  return { archived: true };
}

/** Turns (assistant messages) this site produced today, across all its users. */
export async function siteTurnsToday(siteId: string): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const convIds = (await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.siteId, siteId))).map(r => r.id);
  if (convIds.length === 0) {
    return 0;
  }
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(inArray(messages.conversationId, convIds), eq(messages.role, 'assistant'), gte(messages.createdAt, start)));
  return row?.n ?? 0;
}

export type SiteChatMessage = { id: string; role: string; content: string; createdAt: string };

export async function loadSiteTranscript(conversationId: string, limit = 60): Promise<SiteChatMessage[]> {
  const rows = await db
    .select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse().map(r => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export function liveStatus(conversationId: string) {
  const t = getTurn(conversationId);
  if (!t) {
    return null;
  }
  return {
    iteration: t.iteration,
    lastTool: t.lastTool,
    elapsedMs: Date.now() - t.startedAt,
    stopRequested: t.stopRequested,
    text: liveText.get(conversationId) ?? '',
  };
}

/**
 * Run one turn to completion. Called via `after()` so the HTTP response has
 * already gone out; everything here must persist its own outcome.
 */
export async function runSiteTurn(ctx: SiteChatContext, user: SiteChatUser, conversationId: string, text: string): Promise<void> {
  if (getTurn(conversationId)) {
    return; // a turn is already running for this speaker — the POST guard should have refused
  }
  beginTurn(conversationId, ctx.tenant.id);
  liveText.set(conversationId, '');
  let full = '';
  try {
    const history = (
      await db
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(HISTORY_LIMIT)
    ).reverse().filter((m, i, arr) => !(i === arr.length - 1 && m.role === 'user' && m.content === text)).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as unknown }));

    const [toolset, agent] = await Promise.all([
      buildSiteChatToolset(ctx.tenant.id, { label: ctx.site.label, siteUrl: ctx.site.siteUrl }),
      resolveAgentForTenant(ctx.tenant.id),
    ]);
    const system = siteChatSystemPrompt({
      agent,
      tenantName: ctx.tenant.name,
      site: { label: ctx.site.label, siteUrl: ctx.site.siteUrl, builder: ctx.site.builder },
      user: { name: user.name, role: user.role },
      layoutConnections: toolset.layoutConnections,
      connectionGuidance: toolset.connectionGuidance,
      deferredSummary: toolset.deferredSummary,
      brandVoice: ctx.tenant.brandVoice,
    });
    const notices: unknown[] = [];
    if (toolset.failedConnections.length > 0) {
      notices.push({ type: 'text', text: `[system] Unavailable right now: ${toolset.failedConnections.join('; ')}. Say so plainly if the request needed one.` });
    }
    await runToolLoop({
      tenantId: ctx.tenant.id,
      conversationId,
      surface: 'site',
      system,
      history,
      userText: text,
      userBlocks: notices,
      toolset,
      onDelta: (d) => {
        full += d;
        liveText.set(conversationId, full);
      },
      maxIterations: SITE_TURN_MAX_ITERATIONS,
      wallClockMs: SITE_TURN_WALL_CLOCK_MS,
      shouldStop: () => isStopRequested(conversationId),
      onProgress: (i, t) => noteProgress(conversationId, i, t),
    });
  } catch (err) {
    full += `\n\n[error] ${err instanceof Error ? err.message : 'Agent error'}`;
  } finally {
    if (full.trim()) {
      await db.insert(messages).values({ conversationId, role: 'assistant', content: full }).catch(() => {});
    }
    liveText.delete(conversationId);
    endTurn(conversationId);
  }
}
