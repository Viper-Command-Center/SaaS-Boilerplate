-- Phase 35 — Book publisher (KDP-ready print books).
-- Hand-written, idempotent (same reason as 0020: the drizzle snapshot drifted
-- through 0010–0019 and a generated file re-emits existing tables).
CREATE TABLE IF NOT EXISTS "books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"author" text,
	"kind" varchar(20) DEFAULT 'coloring' NOT NULL,
	"trim_width_in" numeric(6, 3) NOT NULL,
	"trim_height_in" numeric(6, 3) NOT NULL,
	"bleed" boolean DEFAULT false NOT NULL,
	"paper" varchar(10) DEFAULT 'white' NOT NULL,
	"ink" varchar(20) DEFAULT 'black' NOT NULL,
	"single_sided" boolean DEFAULT true NOT NULL,
	"pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cover" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"listing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(12) DEFAULT 'draft' NOT NULL,
	"interior_file_id" uuid,
	"cover_file_id" uuid,
	"cover_preview_file_id" uuid,
	"last_preflight" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "books" ADD CONSTRAINT "books_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "books" ADD CONSTRAINT "books_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "books_tenant_idx" ON "books" USING btree ("tenant_id","updated_at");
