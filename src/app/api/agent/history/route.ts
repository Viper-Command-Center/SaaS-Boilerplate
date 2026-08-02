/**
 * GET /api/agent/history?tenant=<slug> — messages of the user's rolling
 * conversation in that workspace (Phase 1: one conversation per tenant+user).
 *
 * DELETE /api/agent/history?tenant=<slug> — clear the conversation (Phase
 * 26.1). Deletes the MESSAGES only. What survives a clear, deliberately:
 * dashboards, datasets, panels, the file library, saved notes, scheduled
 * tasks, approvals history, and the audit log — i.e. everything the agent
 * treats as durable memory. What's lost is conversational context, which is
 * sometimes the point: a long transcript full of stale threads is exactly
 * what caused the wrong-"try again" and injection-false-positive incidents.
 * Users are told (client-side) to ask the agent to save anything important
 * to a note first.
 */

import { and, asc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { auditLog, conversations, messages } from '@/models/Schema';

export const dynamic = 'force-dynamic';

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
    return NextResponse.json({ ok: true, cleared: 0 });
  }

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
      detail: { messages: deleted.length },
    })
    .catch(() => {});

  return NextResponse.json({ ok: true, cleared: deleted.length });
}
