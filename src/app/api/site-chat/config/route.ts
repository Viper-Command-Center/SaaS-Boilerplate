/**
 * GET /api/site-chat/config — what the WordPress plugin needs to render the
 * chat: the AI employee's name/avatar/accent and the site it is pinned to.
 * Bearer = the site's chat token (Phase 46).
 */

import { NextResponse } from 'next/server';
import { resolveAgentForTenant } from '@/libs/agent/persona';
import { resolveSiteChat } from '@/libs/sitechat/auth';
import { siteBoundConnections } from '@/libs/sitechat/toolset';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ctx = await resolveSiteChat(request);
  if (!ctx) {
    return NextResponse.json({ error: 'Invalid or disabled site token.' }, { status: 401 });
  }
  const [agent, layout] = await Promise.all([
    resolveAgentForTenant(ctx.tenant.id),
    siteBoundConnections(ctx.tenant.id, { label: ctx.site.label, siteUrl: ctx.site.siteUrl }),
  ]);
  return NextResponse.json({
    agent: { name: agent.name, tagline: agent.persona?.tagline ?? null, avatarUrl: agent.avatarUrl ?? null, accent: agent.accent ?? null },
    provider: ctx.tenant.name,
    site: { label: ctx.site.label, url: ctx.site.siteUrl, builder: ctx.site.builder, layoutEditing: layout.layout.length > 0 },
    limits: { dailyTurnCap: ctx.site.chatDailyTurnCap },
  });
}
