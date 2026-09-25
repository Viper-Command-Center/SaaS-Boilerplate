/**
 * Duda → WordPress migration — persistence for `migration_jobs` /
 * `migration_items` (Phase 48, Part 1). The only module that writes those two
 * tables directly, so status transitions and the resume-friendly UPSERT live
 * in one place.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { migrationItems, migrationJobs } from '@/models/Schema';

export type MigrationJob = typeof migrationJobs.$inferSelect;
export type MigrationItem = typeof migrationItems.$inferSelect;

export type ItemType = 'page' | 'post' | 'collection_row' | 'media';
export type ItemStatus = 'extracted' | 'reviewed' | 'mapped' | 'built' | 'failed';
export type JobStatus = 'extracting' | 'awaiting_review' | 'mapping' | 'building' | 'done' | 'failed';

export async function createJob(input: {
  tenantId: string;
  sourceSiteId: string;
  destSiteId?: string | null;
}): Promise<MigrationJob> {
  const [row] = await db
    .insert(migrationJobs)
    .values({
      tenantId: input.tenantId,
      sourceType: 'duda',
      sourceSiteId: input.sourceSiteId,
      destSiteId: input.destSiteId ?? null,
      status: 'extracting',
      currentPhase: 'queued',
    })
    .returning();
  if (!row) {
    throw new Error('Could not create the migration job.');
  }
  return row;
}

export async function getJob(tenantId: string, jobId: string): Promise<MigrationJob | null> {
  const [row] = await db
    .select()
    .from(migrationJobs)
    .where(and(eq(migrationJobs.id, jobId), eq(migrationJobs.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

export async function setJobStatus(
  jobId: string,
  status: JobStatus,
  extra?: { currentPhase?: string; error?: string | null },
): Promise<void> {
  await db
    .update(migrationJobs)
    .set({
      status,
      ...(extra?.currentPhase !== undefined ? { currentPhase: extra.currentPhase } : {}),
      ...(extra?.error !== undefined ? { error: extra.error } : {}),
      updatedAt: new Date(),
    })
    .where(eq(migrationJobs.id, jobId));
}

export async function setJobPhase(jobId: string, currentPhase: string): Promise<void> {
  await db
    .update(migrationJobs)
    .set({ currentPhase, updatedAt: new Date() })
    .where(eq(migrationJobs.id, jobId));
}

/**
 * Insert or update the item for (job, type, sourceRef). Extraction calls this
 * as it finishes each page/post/row/media file, so re-running a job overwrites
 * rather than duplicating — the groundwork for Phase 3's crash-resume.
 */
export async function upsertItem(input: {
  jobId: string;
  itemType: ItemType;
  sourceRef: string;
  status: ItemStatus;
  filePath?: string | null;
  error?: string | null;
}): Promise<void> {
  await db
    .insert(migrationItems)
    .values({
      jobId: input.jobId,
      itemType: input.itemType,
      sourceRef: input.sourceRef,
      status: input.status,
      filePath: input.filePath ?? null,
      error: input.error ?? null,
    })
    .onConflictDoUpdate({
      target: [migrationItems.jobId, migrationItems.itemType, migrationItems.sourceRef],
      set: {
        status: input.status,
        filePath: input.filePath ?? null,
        error: input.error ?? null,
        updatedAt: new Date(),
      },
    });
}

export async function listItems(jobId: string): Promise<MigrationItem[]> {
  return db.select().from(migrationItems).where(eq(migrationItems.jobId, jobId));
}
