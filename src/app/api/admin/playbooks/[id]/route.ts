/**
 * PATCH  /api/admin/playbooks/[id] — { scope?, title?, body?, enabled? }
 *        A body change bumps `version` and pushes the previous body onto
 *        `history` (newest first, capped) with who/when.
 * DELETE /api/admin/playbooks/[id]
 */

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPlaybook, MAX_HISTORY, MAX_PLAYBOOK_BODY, SCOPE_RE } from '@/libs/agent/playbooks';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { playbooks } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const Patch = z.object({
  scope: z.string().trim().regex(SCOPE_RE).optional(),
  title: z.string().trim().min(1).max(160).optional(),
  body: z.string().trim().min(1).max(MAX_PLAYBOOK_BODY).optional(),
  enabled: z.boolean().optional(),
});

type HistoryEntry = { version: number; body: string; changedBy: string | null; changedAt: string };

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const current = await getPlaybook(id);
  if (!current) {
    return NextResponse.json({ error: 'No such playbook.' }, { status: 404 });
  }
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }, { status: 400 });
  }
  const bodyChanged = parsed.data.body !== undefined && parsed.data.body !== current.body;
  const history = bodyChanged
    ? [
        { version: current.version, body: current.body, changedBy: user.email ?? user.id, changedAt: new Date().toISOString() } satisfies HistoryEntry,
        ...((current.history as HistoryEntry[]) ?? []),
      ].slice(0, MAX_HISTORY)
    : (current.history as HistoryEntry[]);
  const [row] = await db
    .update(playbooks)
    .set({
      ...parsed.data,
      version: bodyChanged ? current.version + 1 : current.version,
      history,
      updatedBy: user.id,
      updatedAt: new Date(),
    })
    .where(eq(playbooks.id, id))
    .returning();
  return NextResponse.json({ playbook: row });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const [row] = await db.delete(playbooks).where(eq(playbooks.id, id)).returning({ id: playbooks.id });
  if (!row) {
    return NextResponse.json({ error: 'No such playbook.' }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}
