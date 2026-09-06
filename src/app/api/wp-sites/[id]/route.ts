/**
 * PATCH  /api/wp-sites/:id — edit a site (blank authSecret keeps the stored one),
 *                            or just {policy}, or {setDefault:true}
 * DELETE /api/wp-sites/:id?tenant=<slug>
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { fail, guard, isResponse } from '@/libs/wpsites/access';
import { logSiteEvent } from '@/libs/wpsites/audit';
import { runSiteTest } from '@/libs/wpsites/discovery';
import { deleteSite, getPublicSite, setDefaultSite, setSitePolicy, updateSite } from '@/libs/wpsites/store';

export const dynamic = 'force-dynamic';

const PolicySchema = z.object({
  rest: z.enum(['auto', 'ask', 'blocked']).optional(),
  mcp: z.enum(['auto', 'ask', 'blocked']).optional(),
  cli: z.enum(['auto', 'ask', 'blocked']).optional(),
});

const PatchSchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  label: z.string().min(1).max(80).optional(),
  siteUrl: z.string().min(1).max(500).optional(),
  authScheme: z.enum(['basic', 'bearer']).optional(),
  authUser: z.string().max(120).nullable().optional(),
  authSecret: z.string().max(4000).optional(),
  isDefault: z.boolean().optional(),
  ssh: z.object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).optional(),
    user: z.string().min(1).max(120),
    path: z.string().min(1).max(1000),
    keyId: z.string().uuid().nullable(),
  }).nullable().optional(),
  policy: PolicySchema.optional(),
  setDefault: z.boolean().optional(),
  skipTest: z.boolean().optional(),
});

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: z.infer<typeof PatchSchema>;
  try {
    body = PatchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const g = await guard(body.tenantSlug, 'manage');
  if (isResponse(g)) {
    return g;
  }
  try {
    const current = await getPublicSite(g.tenant.id, id);
    if (!current) {
      return NextResponse.json({ error: 'Site not found.' }, { status: 404 });
    }
    // Policy-only or default-only changes never trigger a re-test.
    if (body.setDefault) {
      await setDefaultSite(g.tenant.id, id);
    }
    const onlyPolicy = body.policy && !body.label && !body.siteUrl && body.authSecret === undefined && body.ssh === undefined && body.authUser === undefined;
    if (onlyPolicy || (body.setDefault && !body.label)) {
      const site = body.policy ? await setSitePolicy(g.tenant.id, id, body.policy) : await getPublicSite(g.tenant.id, id);
      await logSiteEvent(g.tenant.id, id, g.user.id, 'update', { policy: body.policy, setDefault: body.setDefault });
      return NextResponse.json({ site });
    }
    const site = await updateSite(g.tenant.id, id, {
      label: body.label ?? current.label,
      siteUrl: body.siteUrl ?? current.siteUrl,
      authScheme: body.authScheme ?? current.authScheme,
      authUser: body.authUser !== undefined ? body.authUser : current.authUser,
      authSecret: body.authSecret,
      isDefault: body.isDefault,
      ssh: body.ssh !== undefined ? body.ssh : (current.ssh ? { ...current.ssh } : null),
      policy: body.policy,
    });
    await logSiteEvent(g.tenant.id, id, g.user.id, 'update', { label: site.label, secretChanged: Boolean(body.authSecret) });
    if (body.skipTest) {
      return NextResponse.json({ site });
    }
    const report = await runSiteTest(g.tenant.id, id).catch(() => null);
    return NextResponse.json({ site: await getPublicSite(g.tenant.id, id), report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/wp_sites_tenant_label_uq|duplicate key/i.test(msg)) {
      return NextResponse.json({ error: 'A site with that label already exists in this workspace.' }, { status: 409 });
    }
    return fail(err);
  }
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  const g = await guard(slug, 'manage');
  if (isResponse(g)) {
    return g;
  }
  const ok = await deleteSite(g.tenant.id, id);
  if (!ok) {
    return NextResponse.json({ error: 'Site not found.' }, { status: 404 });
  }
  await logSiteEvent(g.tenant.id, id, g.user.id, 'delete');
  return NextResponse.json({ ok: true });
}
