/**
 * POST /api/approvals/[id] — decide a pending approval.
 * Body: { decision: 'approve' | 'reject' }
 * Approve executes the stored MCP tool call and stores the result.
 * Roles: owner/admin/editor (or platform admin).
 */

import { eq, inArray } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { McpHttpClient } from '@/libs/mcp/client';
import { getUserTenants } from '@/libs/tenants';
import { openSecret } from '@/libs/vault';
import { approvals, auditLog, credentials, mcpConnections } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const DECIDER_ROLES = ['owner', 'admin', 'editor'];
const NAME_RE = /^mcp__([a-z0-9-]+)__(.+)$/i;

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

  // Approve → execute the stored call now.
  await db
    .update(approvals)
    .set({ status: 'approved', decidedBy: user.id, decidedAt: new Date() })
    .where(eq(approvals.id, id));

  try {
    const [conn] = approval.connectionId
      ? await db.select().from(mcpConnections).where(eq(mcpConnections.id, approval.connectionId)).limit(1)
      : [undefined];
    if (!conn || !conn.enabled || conn.transport !== 'http' || !conn.url) {
      throw new Error('The tool connection is no longer available.');
    }

    // Decrypt the connection's header credentials.
    const headerMap = (conn.headerCredentials ?? {}) as Record<string, string>;
    const credIds = Object.values(headerMap).filter(Boolean);
    const rows = credIds.length > 0
      ? await db.select({ id: credentials.id, cipher: credentials.cipher }).from(credentials).where(inArray(credentials.id, credIds))
      : [];
    const byId = new Map(rows.map(r => [r.id, r.cipher]));
    const headers: Record<string, string> = {};
    for (const [header, credId] of Object.entries(headerMap)) {
      const cipher = byId.get(credId);
      if (cipher) {
        headers[header] = openSecret(cipher);
      }
    }

    const match = NAME_RE.exec(approval.toolName);
    const rawToolName = match?.[2] ?? approval.toolName;

    const client = new McpHttpClient(conn.url, headers);
    const result = await client.callTool(rawToolName, approval.args as Record<string, unknown>);
    const text = result.content
      .map(c => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`))
      .join('\n')
      .slice(0, 20_000);

    await db
      .update(approvals)
      .set({ status: result.isError ? 'failed' : 'executed', result: { text } })
      .where(eq(approvals.id, id));
    await audit(approval.tenantId, user.id, 'tool.approved_executed', approval.toolName);

    return NextResponse.json({ ok: true, status: result.isError ? 'failed' : 'executed', result: text.slice(0, 2000) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Execution failed';
    await db
      .update(approvals)
      .set({ status: 'failed', result: { error: message.slice(0, 500) } })
      .where(eq(approvals.id, id));
    await audit(approval.tenantId, user.id, 'tool.approved_failed', approval.toolName);
    return NextResponse.json({ ok: false, status: 'failed', error: message }, { status: 502 });
  }
}

async function audit(tenantId: string, actor: string, action: string, target: string): Promise<void> {
  await db.insert(auditLog).values({ tenantId, actor, action, target }).catch(() => {});
}
