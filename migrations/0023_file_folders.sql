-- Phase 40 — folders in the file library. Hand-written, idempotent.
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "folder" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_tenant_folder_idx" ON "files" USING btree ("tenant_id","folder");
