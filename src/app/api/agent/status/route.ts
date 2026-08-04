/**
 * GET /api/agent/status?tenant=slug — is there a live agent turn? (Phase 29)
 *
 * A refreshed page has no open stream, so it can't tell whether the agent is
 * still working. This lets the UI poll: when a turn is active it shows a live
 * "Working — N tool calls · last: X · mm:ss elapsed" indicator and the Stop
 * button, and when the turn flips inactive it reloads history so the finished
 * message appears. Backed by the in-memory activeTurns registry (single
 * container, resets on deploy — a turn in flight during a deploy is lost, same
 * assumption as rateLimit.ts).
 */

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getTurn } from '@/libs/agent/activeTurns';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { conversations } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const INACTIVE = {
  active: false,
  iteration: null,
  lastTool: null,
  startedAt: null,
  stopRequested: false,
  elapsedMs: null,
} as const;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const slug = new URL(request.url).searchParams.get('tenant');
  if (!slug) {
    return NextResponse.json({ error: 'Missing tenant.' }, { status: 400 });
  }

  const tenant = (await getUserTenants(user.id)).find(t => t.slug === slug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }

  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenant.id), eq(conversations.userId, user.id)))
    .limit(1);

  if (!conversation) {
    return NextResponse.json(INACTIVE);
  }

  const turn = getTurn(conversation.id);
  if (!turn) {
    return NextResponse.json(INACTIVE);
  }

  return NextResponse.json({
    active: true,
    iteration: turn.iteration,
    lastTool: turn.lastTool,
    startedAt: turn.startedAt,
    stopRequested: turn.stopRequested,
    elapsedMs: Date.now() - turn.startedAt,
  });
}
