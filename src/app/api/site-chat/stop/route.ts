/** POST /api/site-chat/stop { user } — stop the running turn for that speaker (Phase 46). */

import { NextResponse } from 'next/server';
import { requestStop } from '@/libs/agent/activeTurns';
import { normaliseSiteUser, resolveSiteChat } from '@/libs/sitechat/auth';
import { findOrCreateSiteConversation } from '@/libs/sitechat/turns';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ctx = await resolveSiteChat(request);
  if (!ctx) {
    return NextResponse.json({ error: 'Invalid or disabled site token.' }, { status: 401 });
  }
  const body = await request.json().catch(() => ({})) as { user?: unknown };
  const user = normaliseSiteUser(body.user);
  if (!user) {
    return NextResponse.json({ error: 'user is required.' }, { status: 400 });
  }
  const conv = await findOrCreateSiteConversation(ctx, user);
  return NextResponse.json({ stopped: requestStop(conv.id) });
}
