/**
 * Workspace SSH keys — one key reused across every site so the public half is
 * pasted into the host's panel once.
 *
 * GET    /api/wp-sites/ssh-keys?tenant=<slug>      — public keys + fingerprints
 * POST   /api/wp-sites/ssh-keys {tenantSlug,label?} — mint a key server-side;
 *                                                     only the public half returns
 * DELETE /api/wp-sites/ssh-keys?tenant=<slug>&id=  — remove an unused key
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { fail, guard, isResponse } from '@/libs/wpsites/access';
import { createSshKey, deleteSshKey, listSshKeys } from '@/libs/wpsites/store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const g = await guard(new URL(request.url).searchParams.get('tenant') ?? '', 'read');
  if (isResponse(g)) {
    return g;
  }
  return NextResponse.json({ sshKeys: await listSshKeys(g.tenant.id) });
}

const Body = z.object({ tenantSlug: z.string().min(1).max(80), label: z.string().max(80).optional() });

export async function POST(request: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const g = await guard(body.tenantSlug, 'manage');
  if (isResponse(g)) {
    return g;
  }
  try {
    const key = await createSshKey(g.tenant.id, g.tenant.slug, body.label ?? 'workspace-default');
    return NextResponse.json({ key });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/workspace_ssh_keys_tenant_label_uq|duplicate key/i.test(msg)) {
      return NextResponse.json({ error: 'A key with that label already exists — pick another label.' }, { status: 409 });
    }
    return fail(err);
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const g = await guard(url.searchParams.get('tenant') ?? '', 'manage');
  if (isResponse(g)) {
    return g;
  }
  const id = url.searchParams.get('id') ?? '';
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'id is required.' }, { status: 400 });
  }
  try {
    const ok = await deleteSshKey(g.tenant.id, id);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Key not found.' }, { status: 404 });
  } catch (err) {
    return fail(err);
  }
}
