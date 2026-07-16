/**
 * POST /api/agent/chat — tenant-scoped agent chat with streaming + persistence.
 *
 * Body: { tenantSlug: string, message: string }
 * Response: text/plain stream of the assistant's reply (client reads
 * incrementally). History is loaded server-side from the conversation store —
 * the client never supplies past messages.
 */

import { and, asc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runToolLoop } from '@/libs/agent/loop';
import { resolveAgentForTenant } from '@/libs/agent/persona';
import { buildPlatformTools } from '@/libs/agent/platformTools';
import { buildSystemPrompt } from '@/libs/agent/prompt';
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
import { conversations, messages } from '@/models/Schema';

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

  const history = await db
    .select({ role: messages.role, content: messages.content, attachments: messages.attachments })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .limit(HISTORY_LIMIT);

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
    mcpToolset = { anthropicTools: [], failedConnections: [], resolve: () => null };
  }
  const platform = buildPlatformTools(tenant.id);
  const toolset = {
    anthropicTools: [...platform.anthropicTools, ...mcpToolset.anthropicTools],
    failedConnections: mcpToolset.failedConnections,
    resolve: (name: string) => {
      const p = platform.executors.get(name);
      if (p) {
        return { connectionId: '', connectionName: 'platform', toolName: name, policy: p.policy, call: p.call };
      }
      return mcpToolset.resolve(name);
    },
  };

  // Which AI Employee works this account (name + personality → the prompt).
  const agent = await resolveAgentForTenant(tenant.id);
  let system = buildSystemPrompt({ tenant, userFirstName: user.firstName, agent });
  if (toolset.failedConnections.length > 0) {
    system += `\n\nNote: these configured tool servers are currently unavailable: ${toolset.failedConnections.join('; ')}.`;
  }
  // Only added when images are actually present — costs nothing on text turns,
  // and appending it unconditionally would also invalidate the system-prompt
  // cache for every text-only conversation.
  if (anyImages) {
    system += `\n${imageTrustNote()}`;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = '';
      const onDelta = (delta: string) => {
        full += delta;
        controller.enqueue(encoder.encode(delta));
      };
      try {
        await runToolLoop({
          tenantId: tenant.id,
          conversationId,
          system,
          history: hydrated,
          userText: body.message,
          userBlocks,
          toolset,
          onDelta,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Agent error';
        controller.enqueue(encoder.encode(`\n\n[error] ${msg}`));
      } finally {
        if (full.trim()) {
          await db
            .insert(messages)
            .values({ conversationId, role: 'assistant', content: full })
            .catch(() => {});
        }
        controller.close();
      }
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
