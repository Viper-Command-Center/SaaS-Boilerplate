/**
 * GET /api/agent/history?tenant=<slug> — messages of the user's rolling
 * conversation in that workspace (Phase 1: one conversation per tenant+user).
 *
 * DELETE /api/agent/history?tenant=<slug> — clear the conversation (Phase
 * 26.1). Deletes the MESSAGES only; dashboards, datasets, panels, files,
 * notes, scheduled tasks, approvals and the audit log all survive.
 *
 * CONSOLIDATION (Phase 26.2, the Hindsight pattern): before deleting, the
 * transcript is summarised by a tool-free model call and saved as a "Chat
 * memory" note in the workspace file library. The agent's MEMORY doctrine
 * (prompt.ts) tells it to list_files before claiming it doesn't remember —
 * so context survives a clear as durable memory instead of vanishing. This
 * exists because a real user cleared a chat and the agent then denied all
 * knowledge of a 6-week sprint IT HAD BUILT, despite the tracker sitting on
 * its own dashboard. Consolidation is best-effort: a failed summary must
 * never block the clear the user asked for.
 */

import { and, asc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { callClaudeWithTools } from '@/libs/agent/anthropic';
import { getCurrentUser } from '@/libs/auth/session';
import { meterLlm } from '@/libs/billing/meter';
import { db } from '@/libs/DB';
import { saveFile } from '@/libs/storage/files';
import { getUserTenants } from '@/libs/tenants';
import { auditLog, conversations, messages } from '@/models/Schema';

export const dynamic = 'force-dynamic';
export const maxDuration = 120; // the consolidation summary is one model call

/** Don't bother summarising a trivial transcript. */
const MIN_MESSAGES_TO_CONSOLIDATE = 6;
/** Cap what we feed the summariser — newest messages matter most. */
const MAX_TRANSCRIPT_CHARS = 60_000;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  const tenant = (await getUserTenants(user.id)).find(t => t.slug === slug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenant.id), eq(conversations.userId, user.id)))
    .limit(1);

  if (!conversation) {
    return NextResponse.json({ messages: [] });
  }

  const rows = await db
    .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(asc(messages.createdAt))
    .limit(200);

  return NextResponse.json({ messages: rows });
}

/**
 * Summarise the transcript into a durable note. Best-effort by design.
 * Returns the saved note's name, or null when there was nothing worth
 * saving or the attempt failed.
 */
async function consolidate(
  tenantId: string,
  rows: Array<{ role: string; content: string }>,
): Promise<string | null> {
  if (rows.length < MIN_MESSAGES_TO_CONSOLIDATE) {
    return null;
  }
  try {
    // Newest messages carry the current state — trim from the FRONT.
    let transcript = rows
      .map(m => `${m.role === 'user' ? 'USER' : 'AGENT'}: ${m.content}`)
      .join('\n---\n');
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      transcript = `[…older messages omitted…]\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
    }

    const response = await callClaudeWithTools({
      system: 'You write terse working-memory notes for an AI agent whose chat transcript is about to be cleared. Facts only; no praise, no filler. If the transcript contains nothing worth remembering, reply exactly: NOTHING_DURABLE',
      messages: [{
        role: 'user',
        content: `Summarise this conversation into a memory note the agent will read later via its file library. Cover, tersely: (1) active projects and their CURRENT state (what exists on the dashboard/datasets, what remains), (2) decisions the user made, (3) user preferences or corrections, (4) unresolved threads. Use short headed sections. Under 400 words.\n\n<transcript>\n${transcript}\n</transcript>`,
      }],
      tools: [],
    });

    if (response.usage) {
      await meterLlm({
        tenantId,
        modelId: response._modelId ?? 'unknown',
        usage: {
          inputTokens: response.usage.input_tokens ?? 0,
          outputTokens: response.usage.output_tokens ?? 0,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
        detail: 'chat',
      });
    }

    const summary = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('\n')
      .trim();
    if (!summary || summary.includes('NOTHING_DURABLE')) {
      return null;
    }

    const name = `chat-memory-${new Date().toISOString().slice(0, 10)}.md`;
    const body = `# Chat memory — auto-saved when the conversation was cleared (${new Date().toISOString()})\n\n${summary}\n`;
    const row = await saveFile({
      tenantId,
      name,
      bytes: Buffer.from(body, 'utf8'),
      mime: 'text/markdown',
      kind: 'note',
      source: 'agent',
    });
    return row?.name ?? name;
  } catch (err) {
    console.error('[history] consolidation failed', err);
    return null;
  }
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  const tenant = (await getUserTenants(user.id)).find(t => t.slug === slug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }

  // The conversation is scoped (tenant, user) — users clear only their OWN
  // transcript, so no extra role gate is needed.
  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenant.id), eq(conversations.userId, user.id)))
    .limit(1);

  if (!conversation) {
    return NextResponse.json({ ok: true, cleared: 0, memoryNote: null });
  }

  // Consolidate BEFORE deleting — the transcript is the input.
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(asc(messages.createdAt))
    .limit(200);
  const memoryNote = await consolidate(tenant.id, rows);

  const deleted = await db
    .delete(messages)
    .where(eq(messages.conversationId, conversation.id))
    .returning({ id: messages.id });

  // The clear itself is auditable even though the transcript is gone.
  await db
    .insert(auditLog)
    .values({
      tenantId: tenant.id,
      actor: user.id,
      action: 'conversation.cleared',
      target: conversation.id,
      detail: { messages: deleted.length, memoryNote },
    })
    .catch(() => {});

  return NextResponse.json({ ok: true, cleared: deleted.length, memoryNote });
}
