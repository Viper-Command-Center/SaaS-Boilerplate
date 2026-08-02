-- Phase 27: durable missions (docs/MISSION_RUNNER_SPEC.md).
-- Hand-written, idempotent (the migration-0010 convention): safe to re-run.

CREATE TABLE IF NOT EXISTS "missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mission_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"instructions" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"result" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "missions" ADD CONSTRAINT "missions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_steps" ADD CONSTRAINT "mission_steps_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_steps" ADD CONSTRAINT "mission_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "missions_tenant_status_idx" ON "missions" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_steps_mission_pos_idx" ON "mission_steps" USING btree ("mission_id","position");
