/**
 * POST /api/approvals/[id] — decide a pending approval.
 * Body: { decision: 'approve' | 'reject' }
 * Approve executes the stored MCP tool call, stores the result, AND resumes the
 * conversation so the agent carries on with the task.
 * Roles: owner/admin/editor (or platform admin).
 */

import { asc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runToolLoop } from '@/libs/agent/loop';
import { resolveAgentForTenant } from '@/libs/agent/persona';
import { buildPlatformTools } from '@/libs/agent/platformTools';
import { buildSystemPrompt } from '@/libs/agent/prompt';
import { getCurrentUser } from '@/libs/auth/session';
import { checkSpend } from '@/libs/billing/meter';
import { db } from '@/libs/DB';
import { buildTenantToolset } from '@/libs/mcp/registry';
import { captureIssue } from '@/libs/support/issues';
import { getUserTenants } from '@/libs/tenants';
import { approvals, auditLog, conversations, messages, tenants } from '@/models/Schema';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // built-in media jobs (Kie video) can be slow

const DECIDER_ROLES = ['owner', 'admin', 'editor'];
const HISTORY_LIMIT = 40;

/**
 * Hand the approved call's result back to the agent and let it continue.
 *
 * Returns the agent's reply, or null when there's nothing to resume (an
 * approval raised outside a conversation — e.g. by a scheduled task).
 */
async function resumeConversation(
  approval: typeof approvals.$inferSelect,
  result: string,
): Promise<string | null> {
  if (!approval.conversationId) {
    return null; // scheduled-task approvals have no chat to return to
  }

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, approval.conversationId))
    .limit(1);
  if (!conversation) {
    return null;
  }

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, approval.tenantId)).limit(1);
  if (!tenant) {
    return null;
  }

  const history = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, approval.conversationId))
    .orderBy(asc(messages.createdAt))
    .limit(HISTORY_LIMIT);

  // Show the approval in the transcript. The user really did do this, and
  // without it the agent's next message appears out of nowhere.
  const marker = `✓ Approved: ${approval.toolName}`;
  await db.insert(messages).values({
    conversationId: approval.conversationId,
    role: 'user',
    content: marker,
  });

  let mcpToolset: Awaited<ReturnType<typeof buildTenantToolset>>;
  try {
    mcpToolset = await buildTenantToolset(approval.tenantId);
  } catch {
    mcpToolset = { anthropicTools: [], failedConnections: [], resolve: () => null };
  }
  const platform = buildPlatformTools(approval.tenantId);
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

  const agent = await resolveAgentForTenant(approval.tenantId);
  const system = buildSystemPrompt({ tenant: { ...tenant, role: 'owner' }, agent });

  const userText = `The human approved your queued call to ${approval.toolName} and it has now executed. Its result:

<tool_output trust="untrusted">
${result.slice(0, 12_000)}
</tool_output>

Carry on with the task using this result. Do NOT request the same call again. If you already told the user what you'd do once it came back, do that now.`;

  let reply = '';
  await runToolLoop({
    tenantId: approval.tenantId,
    conversationId: approval.conversationId,
    system,
    history: history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    userText,
    toolset,
    onDelta: (d) => {
      reply += d;
    },
  });

  if (reply.trim()) {
    await db
      .insert(messages)
      .values({ conversationId: approval.conversationId, role: 'assistant', content: reply })
      .catch(() => {});
  }
  return reply.trim() || null;
}

const BodySchema = z.object({ decision: z.enum(['approve', 'reject']) });

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const [approval] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
  if (!approval) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  const tenant = (await getUserTenants(user.id)).find(t => t.id === approval.tenantId);
  if (!tenant || (!user.isAdmin && !DECIDER_ROLES.includes(tenant.role))) {
    return NextResponse.json({ error: 'No access.' }, { status: 403 });
  }
  if (approval.status !== 'pending') {
    return NextResponse.json({ error: `Already ${approval.status}.` }, { status: 409 });
  }

  if (body.decision === 'reject') {
    await db
      .update(approvals)
      .set({ status: 'rejected', decidedBy: user.id, decidedAt: new Date() })
      .where(eq(approvals.id, id));
    await audit(approval.tenantId, user.id, 'tool.rejected', approval.toolName);
    return NextResponse.json({ ok: true, status: 'rejected' });
  }

  // The spend guard must apply HERE too, not just inside the agent loop.
  // Approving is a spending action: a queued Kie video would otherwise run even
  // if the workspace is paused (kill switch) or already over its daily cap.
  const spend = await checkSpend(approval.tenantId);
  if (!spend.allowed) {
    return NextResponse.json(
      { error: `Cannot run this action: ${spend.reason}`, blocked: true },
      { status: 402 },
    );
  }

  // Approve → execute the stored call now.
  await db
    .update(approvals)
    .set({ status: 'approved', decidedBy: user.id, decidedAt: new Date() })
    .where(eq(approvals.id, id));

  try {
    // Execute through the SAME toolset the agent uses. This route used to
    // re-implement HTTP MCP calling itself, which meant:
    //   · built-in providers (Kie.ai, WordPress) could never be approved — they
    //     failed with "the tool connection is no longer available", and
    //   · approved calls skipped metering and asset archiving entirely.
    // One code path, so an approved call behaves exactly like an auto one.
    const toolset = await buildTenantToolset(approval.tenantId);
    const executor = toolset.resolve(approval.toolName);

    if (!executor) {
      const detail = toolset.failedConnections.length > 0
        ? ` Connections reporting problems: ${toolset.failedConnections.join('; ')}`
        : ' Check that the plugin is still enabled in the Tools panel.';
      throw new Error(`"${approval.toolName}" is not available in this workspace right now.${detail}`);
    }

    const text = (await executor.call((approval.args ?? {}) as Record<string, unknown>)).slice(0, 20_000);

    await db
      .update(approvals)
      .set({ status: 'executed', result: { text } })
      .where(eq(approvals.id, id));
    await audit(approval.tenantId, user.id, 'tool.approved_executed', approval.toolName);

    // ── Resume the conversation ──────────────────────────────────────────────
    // The result used to stop here, in the approvals row. The agent had already
    // told the user "I'll show you the result when it comes back" — and nothing
    // ever came back, because nothing told it. The user approved, the agent went
    // silent, and the task died. A promise the platform can't keep makes the
    // agent a liar; this is the platform keeping it.
    const continuation = await resumeConversation(approval, text).catch((err) => {
      // The tool DID run and its result is safe in the approvals row. Failing to
      // narrate that must not turn a success into a reported failure.
      console.error('[approvals] resume failed', err);
      return null;
    });

    return NextResponse.json({
      ok: true,
      status: 'executed',
      result: text.slice(0, 2000),
      continuation,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Execution failed';

    // Triage: tell the user who can actually fix this, and escalate our bugs
    // automatically rather than leaving them to describe the symptom.
    const triaged = await captureIssue({
      tenantId: approval.tenantId,
      source: `approval:${approval.toolName}`,
      error: err,
      detail: { args: approval.args, approvalId: id },
    });

    await db
      .update(approvals)
      .set({ status: 'failed', result: { error: message.slice(0, 500), kind: triaged.kind } })
      .where(eq(approvals.id, id));
    await audit(approval.tenantId, user.id, 'tool.approved_failed', approval.toolName);

    return NextResponse.json({
      ok: false,
      status: 'failed',
      error: message,
      kind: triaged.kind,
      guidance: triaged.clientMessage,
      escalated: triaged.escalate,
    }, { status: 502 });
  }
}

async function audit(tenantId: string, actor: string, action: string, target: string): Promise<void> {
  await db.insert(auditLog).values({ tenantId, actor, action, target }).catch(() => {});
}
