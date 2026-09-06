/**
 * Request guards for /api/wp-sites/*. Same rule as the plugins routes: any
 * member may READ, owners/admins (or a platform admin) may CHANGE.
 */

import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/libs/auth/session';
import { getUserTenants } from '@/libs/tenants';

const MANAGER_ROLES = ['owner', 'admin'];

export type Guarded = {
  user: { id: string; isAdmin: boolean };
  tenant: { id: string; slug: string; role: string };
};

export async function guard(tenantSlug: string, mode: 'read' | 'manage'): Promise<Guarded | NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const tenant = (await getUserTenants(user.id)).find(t => t.slug === tenantSlug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }
  if (mode === 'manage' && !user.isAdmin && !MANAGER_ROLES.includes(tenant.role)) {
    return NextResponse.json({ error: 'You need owner/admin access to manage WordPress sites.' }, { status: 403 });
  }
  return { user: { id: user.id, isAdmin: user.isAdmin }, tenant: { id: tenant.id, slug: tenant.slug, role: tenant.role } };
}

export function isResponse(g: Guarded | NextResponse): g is NextResponse {
  return g instanceof NextResponse;
}

export function fail(err: unknown, status = 400): NextResponse {
  return NextResponse.json({ error: err instanceof Error ? err.message : 'Request failed.' }, { status });
}
