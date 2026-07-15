/**
 * POST /api/approvals/[id] — decide a pending approval.
 * Body: { decision: 'approve' | 'reject' }
 * Approve executes the stored MCP tool call and stores the result.
 * Roles: owner/admin/editor (or platform admin).
 */

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { checkSpend } from '@/libs/billing/meter';
import { db } from '@/libs/DB';
import { buildTenantToolset } from '@/libs/mcp/registry';
import { captureIssue } from '@/libs/support/issues';
import { getUserTenants } from '@/libs/tenants';
import { approvals, auditLog } from '@/models/Schema';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // built-in media jobs (Kie video) can be slow

const DECIDER_ROLES = ['owner', 'admin', 'editor'];

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

    return NextResponse.json({ ok: true, status: 'executed', result: text.slice(0, 2000) });
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
