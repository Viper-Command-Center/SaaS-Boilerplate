/**
 * POST /api/agent/chat — tenant-scoped agent chat with streaming + persistence.
 *
 * Body: { tenantSlug: string, message: string }
 * Response: text/plain stream of the assistant's reply (client reads
 * incrementally). History is loaded server-side from the conversation store —
 * the client never supplies past messages.
 *
 * STOP (Phase 29): Stop is now an EXPLICIT signal, not a client disconnect.
 * A page REFRESH aborts the stream too, and the old code treated that abort as
 * Stop (cancel() set a flag the loop read) — so a user refreshing to check on a
 * long task was silently KILLING the run. Now: the loop reads the activeTurns
 * registry (isStopRequested), which is only set by POST /api/agent/stop; the
 * stream's cancel() is a documented no-op. Disconnect is harmless — the handler
 * keeps running on Railway (Node doesn't kill the handler when the client goes
 * away), the message is persisted in the finally block, and a refreshed page
 * picks the live turn back up via GET /api/agent/status.
 */

import { and, desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { beginTurn, endTurn, isStopRequested, noteProgress } from '@/libs/agent/activeTurns';
import { runToolLoop } from '@/libs/agent/loop';
import { buildMissionTools } from '@/libs/agent/missionTools';
import { resolveAgentForTenant } from '@/libs/agent/persona';
import { buildPlatformTools } from '@/libs/agent/platformTools';
import { buildSystemPrompt } from '@/libs/agent/prompt';
import { checkRateLimit } from '@/libs/agent/rateLimit';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { buildTenantToolset } from '@/libs/mcp/registry';
import { getUserTenants } from '@/libs/tenants';
import {
  MAX_IMAGES_PER_MESSAGE,
  droppedImageNote,
  imageTrustNote,
  loadImageBlocks,
  selectImagesForContext,
} from '@/libs/agent/vision';
import { conversations, messages, tenants } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  message: z.string().min(1).max(32_000),
  /**
   * File ids of images pasted into the composer. Already uploaded to R2 via
   * /api/files/upload, so this is a reference — never image bytes over the wire
   * twice. Every id is re-scoped to the tenant in loadImageBlocks().
   */
  attachments: z.array(z.string().uuid()).max(MAX_IMAGES_PER_MESSAGE).optional(),
});

const HISTORY_LIMIT = 40;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  // Tenant scoping: the user must be a member of the requested workspace.
  const tenant = (await getUserTenants(user.id)).find(t => t.slug === body.tenantSlug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }

  // Velocity guard (Phase 27): a runaway loop hammering this route is a money
  // problem before it is a load problem — each turn can be dozens of model
  // calls. The spend cap bounds dollars; this bounds requests per minute.
  const rate = checkRateLimit(tenant.id);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: `Too many agent turns at once — wait ${rate.retryAfterSec}s and try again.` },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } },
    );
  }

  // One rolling conversation per (tenant, user) for Phase 1.
  let [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenant.id), eq(conversations.userId, user.id)))
    .limit(1);
  if (!conversation) {
    [conversation] = await db
      .insert(conversations)
      .values({ tenantId: tenant.id, userId: user.id, title: 'Agent chat' })
      .returning();
  }
  if (!conversation) {
    return NextResponse.json({ error: 'Could not open the conversation.' }, { status: 500 });
  }
  const conversationId = conversation.id;

  // 🔴 NEWEST 40, then flip back to chronological order. This was
  // `orderBy(asc).limit(40)` — the OLDEST 40 messages of the one rolling
  // conversation — so once a conversation crossed 40 messages the agent was
  // permanently frozen in its earliest window: it answered every new request
  // against week-old context and could not see the message it was replying
  // to being preceded by anything recent. (The "Max is very confused /
  // talking about LinkedIn when I asked for blog posts" incident, 2026-08-03.)
  const history = (
    await db
      .select({ role: messages.role, content: messages.content, attachments: messages.attachments })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_LIMIT)
  ).reverse();

  const attachments = body.attachments ?? [];

  await db.insert(messages).values({
    conversationId,
    role: 'user',
    content: body.message,
    attachments: attachments.length > 0 ? attachments : null,
  });

  // ── Vision ────────────────────────────────────────────────────────────────
  // Rebuild past turns WITH their images, so a follow-up like "now make that
  // panel wider" still has the screenshot in view. Bounded by
  // MAX_IMAGES_IN_CONTEXT — oldest images fall out first and leave an honest
  // marker, because a model that doesn't know an image existed will answer
  // confidently as though it never did.
  const { keep } = selectImagesForContext([...history, { attachments }]);

  const hydrated = await Promise.all(
    history.map(async (m) => {
      const ids = (m.attachments ?? []).filter(id => keep.has(id));
      const dropped = (m.attachments ?? []).length - ids.length;
      if (ids.length === 0 && dropped === 0) {
        return { role: m.role as 'user' | 'assistant', content: m.content as unknown };
      }
      const blocks = await loadImageBlocks(tenant.id, ids);
      return {
        role: m.role as 'user' | 'assistant',
        content: [
          ...blocks,
          ...(dropped > 0 ? [droppedImageNote()] : []),
          { type: 'text', text: m.content },
        ] as unknown,
      };
    }),
  );

  // This turn's images. Placed before the user's text by runToolLoop.
  const userBlocks = attachments.length > 0
    ? await loadImageBlocks(tenant.id, attachments.filter(id => keep.has(id)))
    : [];

  const anyImages = userBlocks.length > 0 || hydrated.some(m => Array.isArray(m.content));

  // Assemble the tenant's live toolset: platform tools (always available —
  // dashboard panels + datasets) merged with the tenant's enabled MCP
  // connections. MCP failures are tolerated — the agent still works.
  let mcpToolset: Awaited<ReturnType<typeof buildTenantToolset>>;
  try {
    mcpToolset = await buildTenantToolset(tenant.id);
  } catch {
    mcpToolset = { anthropicTools: [], failedConnections: [], resolve: () => null, deferredSummary: '' };
  }
  const platform = buildPlatformTools(tenant.id);
  const mission = buildMissionTools(tenant.id);
  const toolset = {
    anthropicTools: [...platform.anthropicTools, ...mission.anthropicTools, ...mcpToolset.anthropicTools],
    failedConnections: mcpToolset.failedConnections,
    deferredSummary: mcpToolset.deferredSummary,
    resolve: (name: string) => {

      const p = platform.executors.get(name) ?? mission.executors.get(name);
      if (p) {
        return { connectionId: '', connectionName: 'platform', toolName: name, policy: p.policy, call: p.call };
      }
      return mcpToolset.resolve(name);
    },
  };

  // Which AI Employee works this account (name + personality → the prompt).
  const agent = await resolveAgentForTenant(tenant.id);
  // Standing workspace memory (Phase 28): durable facts auto-injected into
  // every turn, so "which repo is the blog in" never depends on the agent
  // choosing to look it up.
  const [memRow] = await db
    .select({ agentMemory: tenants.agentMemory })
    .from(tenants)
    .where(eq(tenants.id, tenant.id))
    .limit(1);
  let system = buildSystemPrompt({ tenant, userFirstName: user.firstName, agent, memory: memRow?.agentMemory });
  // Only added when images are actually present — costs nothing on text turns,
  // and appending it unconditionally would also invalidate the system-prompt
  // cache for every text-only conversation.
  if (anyImages) {
    system += `\n${imageTrustNote()}`;
  }

  // Deferred tool collections (Phase 29 token diet): big connections (≥10
  // tools) are not shipped as schemas until the model calls load_connection_tools.
  // Tell it plainly they exist and how to load them — same conditional-append
  // pattern as imageTrustNote() above, so the system-cache prefix only carries
  // this when there is actually something deferred.
  if (mcpToolset.deferredSummary) {
    system += `\nSome tool collections are DEFERRED to keep context small: ${mcpToolset.deferredSummary}. Call load_connection_tools with the connection name before using them.`;
  }

  // ── Failed connections ────────────────────────────────────────────────────
  // 🔴 This note used to be appended to `system`, which put it INSIDE the
  // cache_control breakpoint that caches the ~77k-token tools+system prefix.
  // And the note embeds the server's VERBATIM error text, which routinely
  // carries a request-id or timestamp. So a single flaky server re-wrote the
  // entire prefix at 1.25x on EVERY turn, for as long as it stayed flaky —
  // making the cheapest moment to be flaky the most expensive. Exactly the
  // reasoning applied to imageTrustNote() above, and never applied here.
  //
  // It now rides the user message instead: outside the system cache, inside the
  // per-turn message breakpoint (which changes every turn anyway, so there is
  // nothing to bust). The agent still gets the full, real error — the Phase 14
  // rule that it must be told the truth and not invent remediation is intact.
  const notices: unknown[] = [];
  if (toolset.failedConnections.length > 0) {
    notices.push({
      type: 'text',
      text: `[system] These configured tool servers are unavailable right now: ${toolset.failedConnections.join('; ')}.\n`
        + `Their tools are missing from this turn. If the user asks for something that needed one, say plainly that the connection is down and quote the error above — do NOT invent troubleshooting steps the error does not state, and do NOT suggest a different product as though it were configured here. You cannot see the platform's code or logs.`,
    });
  }

  // ── Turn registry (Phase 29) ──────────────────────────────────────────────
  // Register this turn BEFORE running the loop so a Stop request (POST
  // /api/agent/stop) and a status poll (GET /api/agent/status) can find it.
  beginTurn(conversationId, tenant.id);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = '';
      const onDelta = (delta: string) => {
        full += delta;
        // After a client abort, enqueue() throws — but `full` must keep
        // accumulating so the persisted message includes any trailing lines.
        try {
          controller.enqueue(encoder.encode(delta));
        } catch {
          // Client is gone; persistence below is what matters now.
        }
      };
      try {
        await runToolLoop({
          tenantId: tenant.id,
          conversationId,
          system,
          history: hydrated,
          userText: body.message,
          // Notices first, then images, then the user's text (Anthropic's
          // guidance is images before the question that asks about them).
          userBlocks: [...notices, ...userBlocks],
          toolset,
          onDelta,
          // Stop is now EXPLICIT: only a POST /api/agent/stop sets this. A
          // client disconnect (refresh/close) no longer stops the run.
          shouldStop: () => isStopRequested(conversationId),
          // Live progress → registry, so a refreshed page shows the turn alive.
          onProgress: (i, t) => noteProgress(conversationId, i, t),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Agent error';
        onDelta(`\n\n[error] ${msg}`);
      } finally {
        // The message-persistence finally runs even after a client disconnect —
        // on Railway the Node handler keeps executing, so a refreshed user
        // picks the finished message up from history (loadHistory()).
        if (full.trim()) {
          await db
            .insert(messages)
            .values({ conversationId, role: 'assistant', content: full })
            .catch(() => {});
        }
        endTurn(conversationId);
        try {
          controller.close();
        } catch {
          // Already cancelled — nothing to close.
        }
      }
    },
    cancel() {
      // Client went away (refresh / closed tab). DELIBERATE no-op: keep working.
      // The message persists via the finally block above and the user picks it
      // up from history. Stopping is now the explicit /api/agent/stop signal —
      // a disconnect must NOT kill the run (the Phase 29 refresh-kills-work fix).
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
