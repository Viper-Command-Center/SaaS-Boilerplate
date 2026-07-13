/**
 * Stream a stored file back to the browser, with the workspace membership
 * check applied. Used when the bucket has no public domain (or for private
 * knowledge docs you never want on a public URL).
 */

import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/libs/auth/session';
import { getFile } from '@/libs/storage/files';
import { getObject } from '@/libs/storage/r2';
import { getUserTenants } from '@/libs/tenants';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  const slug = new URL(request.url).searchParams.get('tenant') ?? '';

  const tenant = (await getUserTenants(user.id)).find(t => t.slug === slug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }

  const row = await getFile(tenant.id, id);
  if (!row) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  try {
    const { body, contentType } = await getObject(row.r2Key);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        'Content-Type': row.mime || contentType,
        'Content-Disposition': `inline; filename="${row.name.replace(/"/g, '')}"`,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Could not read the file from storage.' }, { status: 502 });
  }
}
