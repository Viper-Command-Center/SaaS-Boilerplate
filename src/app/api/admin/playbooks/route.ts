/**
 * GET  /api/admin/playbooks — every playbook (all scopes, enabled or not)
 * POST /api/admin/playbooks — { scope, title, body, enabled? } → creates one
 *
 * Phase 37. Platform admin only. Scope is "*" (every agent), a built-in
 * provider slug ("wp-sites") or "stdio:<key>". See src/libs/agent/playbooks.ts.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listPlaybooks, MAX_PLAYBOOK_BODY, SCOPE_RE } from '@/libs/agent/playbooks';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { playbooks } from '@/models/Schema';

export const dynamic = 'force-dynamic';

export const PlaybookInput = z.object({
  scope: z.string().trim().regex(SCOPE_RE, 'scope must be "*", a provider slug, or stdio:<key>'),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(MAX_PLAYBOOK_BODY),
  enabled: z.boolean().optional(),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }
  return NextResponse.json({ playbooks: await listPlaybooks() });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }
  const parsed = PlaybookInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }, { status: 400 });
  }
  const [row] = await db
    .insert(playbooks)
    .values({ ...parsed.data, enabled: parsed.data.enabled ?? true, updatedBy: user.id })
    .returning();
  return NextResponse.json({ playbook: row });
}
