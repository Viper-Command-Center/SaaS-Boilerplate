-- Phase 46 — Site Chat: the WordPress plugin talks to the workspace agent on
-- behalf of a site's own users. Hand-written, idempotent.
ALTER TABLE "wp_sites" ADD COLUMN IF NOT EXISTS "chat_token_hash" varchar(64);
--> statement-breakpoint
ALTER TABLE "wp_sites" ADD COLUMN IF NOT EXISTS "chat_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "wp_sites" ADD COLUMN IF NOT EXISTS "chat_daily_turn_cap" integer NOT NULL DEFAULT 60;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wp_sites_chat_token_idx" ON "wp_sites" USING btree ("chat_token_hash");
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "site_id" uuid;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "external_key" varchar(120);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_site_id_wp_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."wp_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_site_idx" ON "conversations" USING btree ("site_id","external_key");
