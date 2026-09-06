-- Phase 34 — WordPress Sites connector.
-- Hand-trimmed: drizzle-kit's snapshot had drifted (migrations 0010–0019 were
-- hand-written) so the generated file re-emitted tables that already exist.
-- Only the two new tables are here, written idempotently so a re-run is safe.
-- meta/0020_snapshot.json IS the regenerated full snapshot, so the next
-- `db:generate` starts from a truthful baseline.
CREATE TABLE IF NOT EXISTS "workspace_ssh_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" varchar(80) NOT NULL,
	"public_key" text NOT NULL,
	"private_key_enc" text NOT NULL,
	"fingerprint" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wp_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" varchar(60) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"site_url" text NOT NULL,
	"auth_scheme" varchar(10) DEFAULT 'basic' NOT NULL,
	"auth_user" varchar(120),
	"auth_secret_enc" text NOT NULL,
	"app_password_uuid" varchar(60),
	"ssh_host" varchar(255),
	"ssh_port" integer,
	"ssh_user" varchar(120),
	"wp_path" text,
	"ssh_key_id" uuid,
	"mcp_endpoint_url" text,
	"wp_version" varchar(40),
	"php_version" varchar(40),
	"builder" varchar(20),
	"builder_version" varchar(40),
	"agent_connector_version" varchar(40),
	"capabilities" jsonb,
	"policy" jsonb,
	"status" varchar(12) DEFAULT 'untested' NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_report" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "workspace_ssh_keys" ADD CONSTRAINT "workspace_ssh_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "wp_sites" ADD CONSTRAINT "wp_sites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "wp_sites" ADD CONSTRAINT "wp_sites_ssh_key_id_workspace_ssh_keys_id_fk" FOREIGN KEY ("ssh_key_id") REFERENCES "public"."workspace_ssh_keys"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_ssh_keys_tenant_idx" ON "workspace_ssh_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_ssh_keys_tenant_label_uq" ON "workspace_ssh_keys" USING btree ("tenant_id","label");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wp_sites_tenant_idx" ON "wp_sites" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wp_sites_tenant_label_uq" ON "wp_sites" USING btree ("tenant_id","label");
