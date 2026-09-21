/**
 * Site Chat transcript + turns (Phase 46). Bearer = site chat token.
 *
 * GET  ?user=<wp user id>              → { messages[], live }  (poll every ~2s while live)
 * POST { user:{id,name,role}, message } → 202 { conversationId } — the turn runs
 *      after the response; the plugin polls GET until `live` is null.
 */

import { after, NextResponse } from 'next/server';
import { z } from 'zod';
import { getTurn } from '@/libs/agent/activeTurns';
import { checkRateLimit } from '@/libs/agent/rateLimit';
import { db } from '@/libs/DB';
import { normaliseSiteUser, resolveSiteChat } from '@/libs/sitechat/auth';
import { findOrCreateSiteConversation, liveStatus, loadSiteTranscript, runSiteTurn, siteTurnsToday } from '@/libs/sitechat/turns';
import { messages } from '@/models/Schema';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const PostSchema = z.object({
  user: z.object({ id: z.union([z.string(), z.number()]), name: z.string().optional(), role: z.string().optional() }),
  message: z.string().min(1).max(16_000),
});

export async function GET(request: Request) {
  const ctx = await resolveSiteChat(request);
  if (!ctx) {
    return NextResponse.json({ error: 'Invalid or disabled site token.' }, { status: 401 });
  }
  const url = new URL(request.url);
  const user = normaliseSiteUser({ id: url.searchParams.get('user'), name: url.searchParams.get('name'), role: url.searchParams.get('role') });
  if (!user) {
    return NextResponse.json({ error: 'user is required.' }, { status: 400 });
  }
  const conv = await findOrCreateSiteConversation(ctx, user);
  const [transcript, live] = [await loadSiteTranscript(conv.id), liveStatus(conv.id)];
  return NextResponse.json({ conversationId: conv.id, messages: transcript, live });
}

export async function POST(request: Request) {
  const ctx = await resolveSiteChat(request);
  if (!ctx) {
    return NextResponse.json({ error: 'Invalid or disabled site token.' }, { status: 401 });
  }
  let body: z.infer<typeof PostSchema>;
  try {
    body = PostSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const user = normaliseSiteUser({ ...body.user, id: String(body.user.id) });
  if (!user) {
    return NextResponse.json({ error: 'user.id is required.' }, { status: 400 });
  }
  if (ctx.tenant.paused) {
    return NextResponse.json({ error: 'The assistant is paused for this account. Contact your provider.' }, { status: 402 });
  }
  const rate = checkRateLimit(ctx.site.id, 'site-chat');
  if (!rate.allowed) {
    return NextResponse.json({ error: `Too many requests — wait ${rate.retryAfterSec}s.` }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } });
  }
  const today = await siteTurnsToday(ctx.site.id);
  if (today >= ctx.site.chatDailyTurnCap) {
    return NextResponse.json({ error: `This site has used its ${ctx.site.chatDailyTurnCap} assistant requests for today. It resets at midnight UTC.` }, { status: 429 });
  }
  const conv = await findOrCreateSiteConversation(ctx, user);
  if (getTurn(conv.id)) {
    return NextResponse.json({ error: 'The assistant is still working on your previous request.' }, { status: 409 });
  }
  await db.insert(messages).values({ conversationId: conv.id, role: 'user', content: body.message });
  after(() => runSiteTurn(ctx, user, conv.id, body.message));
  return NextResponse.json({ conversationId: conv.id, accepted: true }, { status: 202 });
}
