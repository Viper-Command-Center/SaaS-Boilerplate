-- Phase 48 — Duda → WordPress migration, Part 1 (foundation). Two tenant-scoped
-- tables: migration_jobs (one per migration) and migration_items (one per
-- page/post/collection-row/media file, so a crashed job resumes from the last
-- completed item once Phase 3 exists). Hand-written, idempotent — same
-- discipline as 0020–0028 (drizzle-kit's snapshot has drifted since the
-- hand-written 0010+, so we do NOT rely on `drizzle-kit generate` here).
--
-- REQUIRED BY: src/models/Schema.ts (migrationJobs, migrationItems) and
-- src/libs/migration/duda/* which read/write these tables during extraction.
CREATE TABLE IF NOT EXISTS "migration_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_type" varchar(20) DEFAULT 'duda' NOT NULL,
	"source_site_id" text NOT NULL,
	"dest_site_id" uuid,
	"status" varchar(20) DEFAULT 'extracting' NOT NULL,
	"current_phase" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "migration_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"item_type" varchar(20) NOT NULL,
	"source_ref" text NOT NULL,
	"status" varchar(20) DEFAULT 'extracted' NOT NULL,
	"file_path" text,
	"built_ref" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "migration_jobs" ADD CONSTRAINT "migration_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "migration_jobs" ADD CONSTRAINT "migration_jobs_dest_site_id_wp_sites_id_fk" FOREIGN KEY ("dest_site_id") REFERENCES "public"."wp_sites"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "migration_items" ADD CONSTRAINT "migration_items_job_id_migration_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."migration_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "migration_jobs_tenant_idx" ON "migration_jobs" USING btree ("tenant_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "migration_items_job_idx" ON "migration_items" USING btree ("job_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "migration_items_job_ref_uq" ON "migration_items" USING btree ("job_id","item_type","source_ref");
