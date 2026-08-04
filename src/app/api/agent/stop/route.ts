/**
 * POST /api/agent/stop — explicitly stop the caller's live agent turn (Phase 29).
 *
 * Body: { tenantSlug: string }
 *
 * Stop used to be implicit (a client disconnect). That silently killed a run
 * whenever the user REFRESHED to check progress. Now Stop is an EXPLICIT signal:
 * this route flips stopRequested in the activeTurns registry, and the tool loop
 * halts on its next iteration and emits the same [stopped] marker as before.
 * Any workspace member may stop their OWN rolling conversation.
 */

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requestStop } from '@/libs/agent/activeTurns';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { conversations } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  tenantSlug: z.string().min(1).max(80),
});

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

  // Any member of the workspace may stop their own conversation.
  const tenant = (await getUserTenants(user.id)).find(t => t.slug === body.tenantSlug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }

  // The user's one rolling conversation for this tenant (same query as chat).
  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenant.id), eq(conversations.userId, user.id)))
    .limit(1);

  if (!conversation) {
    return NextResponse.json({ ok: true, stopping: false });
  }

  // requestStop returns false when there is no active turn to stop.
  const stopping = requestStop(conversation.id);
  return NextResponse.json({ ok: true, stopping });
}
