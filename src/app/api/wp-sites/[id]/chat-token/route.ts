/**
 * Site Chat token management (Phase 46). Owners/admins of the workspace.
 *
 * POST   {tenantSlug}                      → mint a new token (returned ONCE), enables chat
 * PATCH  {tenantSlug, enabled?, dailyCap?} → toggle / cap
 * DELETE ?tenant=<slug>                    → revoke (token hash cleared, chat disabled)
 */

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/libs/DB';
import { mintSiteToken } from '@/libs/sitechat/auth';
import { guard, isResponse } from '@/libs/wpsites/access';
import { logSiteEvent } from '@/libs/wpsites/audit';
import { wpSites } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const PostBody = z.object({ tenantSlug: z.string().min(1).max(80) });
const PatchBody = z.object({
  tenantSlug: z.string().min(1).max(80),
  enabled: z.boolean().optional(),
  dailyCap: z.number().int().min(1).max(2000).optional(),
});

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const g = await guard(body.tenantSlug, 'manage');
  if (isResponse(g)) {
    return g;
  }
  const { token, hash } = mintSiteToken();
  const [row] = await db
    .update(wpSites)
    .set({ chatTokenHash: hash, chatEnabled: true, updatedAt: new Date() })
    .where(and(eq(wpSites.id, id), eq(wpSites.tenantId, g.tenant.id)))
    .returning({ id: wpSites.id, label: wpSites.label });
  if (!row) {
    return NextResponse.json({ error: 'Site not found.' }, { status: 404 });
  }
  await logSiteEvent(g.tenant.id, id, g.user.id, 'chat_token.mint', { label: row.label });
  return NextResponse.json({ token, artivioUrl: process.env.PRODUCTION_URL ?? 'https://artivio.ai' });
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: z.infer<typeof PatchBody>;
  try {
    body = PatchBody.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const g = await guard(body.tenantSlug, 'manage');
  if (isResponse(g)) {
    return g;
  }
  const [row] = await db
    .update(wpSites)
    .set({
      ...(body.enabled !== undefined ? { chatEnabled: body.enabled } : {}),
      ...(body.dailyCap !== undefined ? { chatDailyTurnCap: body.dailyCap } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(wpSites.id, id), eq(wpSites.tenantId, g.tenant.id)))
    .returning({ chatEnabled: wpSites.chatEnabled, chatDailyTurnCap: wpSites.chatDailyTurnCap, hasToken: wpSites.chatTokenHash });
  if (!row) {
    return NextResponse.json({ error: 'Site not found.' }, { status: 404 });
  }
  await logSiteEvent(g.tenant.id, id, g.user.id, 'chat_token.update', { enabled: row.chatEnabled, dailyCap: row.chatDailyTurnCap });
  return NextResponse.json({ chatEnabled: row.chatEnabled, chatDailyTurnCap: row.chatDailyTurnCap, hasToken: Boolean(row.hasToken) });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  const g = await guard(slug, 'manage');
  if (isResponse(g)) {
    return g;
  }
  const [row] = await db
    .update(wpSites)
    .set({ chatTokenHash: null, chatEnabled: false, updatedAt: new Date() })
    .where(and(eq(wpSites.id, id), eq(wpSites.tenantId, g.tenant.id)))
    .returning({ id: wpSites.id });
  if (!row) {
    return NextResponse.json({ error: 'Site not found.' }, { status: 404 });
  }
  await logSiteEvent(g.tenant.id, id, g.user.id, 'chat_token.revoke', {});
  return NextResponse.json({ ok: true });
}
