import { and, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { diviSiteDesigns } from '@/models/Schema';
import { DesignSchema } from './patterns';

export async function loadSiteDesign(tenantId: string, connectionId: string, target: string) {
  const [row] = await db.select().from(diviSiteDesigns).where(and(eq(diviSiteDesigns.tenantId, tenantId), eq(diviSiteDesigns.connectionId, connectionId))).limit(1);
  // Rebinding a connection must not carry another site's design silently.
  return row?.target === target ? DesignSchema.parse(row.design) : undefined;
}

export async function saveSiteDesign(tenantId: string, connectionId: string, target: string, input: unknown) {
  const design = DesignSchema.parse(input);
  await db.insert(diviSiteDesigns).values({ tenantId, connectionId, target, design }).onConflictDoUpdate({
    target: [diviSiteDesigns.tenantId, diviSiteDesigns.connectionId],
    set: { target, design, updatedAt: new Date() },
  });
  return design;
}
