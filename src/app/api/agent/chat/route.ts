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
import { buildPlatformTools } from '@/libs/agent/platformTools';
import { buildSystemPrompt } from '@/libs/agent/prompt';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { buildTenantToolset } from '@/libs/mcp/registry';
import { getUserTenants } from '@/libs/tenants';
import { conversations, messages } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  message: z.string().min(1).max(32_000),
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
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .limit(HISTORY_LIMIT);

  await db.insert(messages).values({
    conversationId,
    role: 'user',
    content: body.message,
  });

  const chatMessages = [
    ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: body.message },
  ];

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

  let system = buildSystemPrompt({ tenant, userFirstName: user.firstName });
  if (toolset.failedConnections.length > 0) {
    system += `\n\nNote: these configured tool servers are currently unavailable: ${toolset.failedConnections.join('; ')}.`;
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
          history: chatMessages.slice(0, -1),
          userText: body.message,
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
