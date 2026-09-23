/** POST /api/site-chat/reset { user } — archive the speaker's current conversation and start fresh (Phase 46). */

import { NextResponse } from 'next/server';
import { normaliseSiteUser, resolveSiteChat } from '@/libs/sitechat/auth';
import { archiveSiteConversation } from '@/libs/sitechat/turns';

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
  const result = await archiveSiteConversation(ctx, user);
  if (!result.archived) {
    return NextResponse.json({ error: result.reason ?? 'Could not start a new conversation.' }, { status: 409 });
  }
  return NextResponse.json({ archived: true });
}
