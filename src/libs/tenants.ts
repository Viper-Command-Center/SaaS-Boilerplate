import { eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { memberships, tenants } from '@/models/Schema';

export type TenantWithRole = {
  id: string;
  name: string;
  slug: string;
  vertical: string | null;
  brandVoice: unknown;
  settings: unknown;
  role: string;
};

/** All tenants the user can access, with their role. */
export async function getUserTenants(userId: string): Promise<TenantWithRole[]> {
  const rows = await db
    .select({ tenant: tenants, role: memberships.role })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .where(eq(memberships.userId, userId));
  return rows.map(r => ({ ...r.tenant, role: r.role }));
}

/**
 * Ensures the platform admin always has at least one workspace. Creates the
 * default "artivio" tenant + owner membership on first dashboard visit.
 */
export async function ensureDefaultTenant(userId: string, isAdmin: boolean): Promise<TenantWithRole[]> {
  const existing = await getUserTenants(userId);
  if (existing.length > 0 || !isAdmin) {
    return existing;
  }

  let [tenant] = await db.select().from(tenants).where(eq(tenants.slug, 'artivio')).limit(1);
  if (!tenant) {
    [tenant] = await db
      .insert(tenants)
      .values({ name: 'Artivio', slug: 'artivio', vertical: 'agency' })
      .returning();
  }
  if (!tenant) {
    return [];
  }

  await db
    .insert(memberships)
    .values({ userId, tenantId: tenant.id, role: 'owner' })
    .onConflictDoNothing();

  return getUserTenants(userId);
}
