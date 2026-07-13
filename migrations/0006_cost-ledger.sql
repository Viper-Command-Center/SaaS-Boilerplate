CREATE TABLE "plugin_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(80) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" varchar(40),
	"tier" varchar(10) DEFAULT 'tier2' NOT NULL,
	"transport" varchar(12) DEFAULT 'http' NOT NULL,
	"url" text,
	"auth_header" varchar(80),
	"auth_hint" text,
	"credential_id" uuid,
	"price_rules" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"source" varchar(120) NOT NULL,
	"detail" varchar(160),
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"quantity" numeric(12, 4),
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"billed_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "plan_name" varchar(40) DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "monthly_budget_usd" numeric(10, 2) DEFAULT '50' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "daily_cap_usd" numeric(10, 2) DEFAULT '10' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_catalog_slug_uq" ON "plugin_catalog" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "usage_events_tenant_at_idx" ON "usage_events" USING btree ("tenant_id","at");