CREATE TABLE IF NOT EXISTS "dashboard_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"icon" varchar(8),
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dashboard_views" ADD CONSTRAINT "dashboard_views_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboard_views_tenant_idx" ON "dashboard_views" USING btree ("tenant_id","position");
--> statement-breakpoint
ALTER TABLE "dashboard_panels" ADD COLUMN IF NOT EXISTS "view_id" uuid;
--> statement-breakpoint
ALTER TABLE "dashboard_panels" ADD COLUMN IF NOT EXISTS "section" varchar(60);
--> statement-breakpoint
ALTER TABLE "dashboard_panels" ADD COLUMN IF NOT EXISTS "width" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dashboard_panels" ADD CONSTRAINT "dashboard_panels_view_id_dashboard_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."dashboard_views"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboard_panels_view_idx" ON "dashboard_panels" USING btree ("view_id","position");
--> statement-breakpoint
-- Backfill: every tenant that already has panels gets an "Overview" view and
-- its existing panels move into it. Without this, live dashboards (Bargain
-- Balloons has ~12 panels) would render as "unfiled" on day one.
-- Idempotent: only creates the view for tenants that don't have one yet.
INSERT INTO "dashboard_views" ("tenant_id", "name", "icon", "position")
SELECT DISTINCT p."tenant_id", 'Overview', '🏠', 0
FROM "dashboard_panels" p
WHERE NOT EXISTS (
  SELECT 1 FROM "dashboard_views" v WHERE v."tenant_id" = p."tenant_id"
);
--> statement-breakpoint
UPDATE "dashboard_panels" p
SET "view_id" = (
  SELECT v."id" FROM "dashboard_views" v
  WHERE v."tenant_id" = p."tenant_id"
  ORDER BY v."position" ASC, v."created_at" ASC
  LIMIT 1
)
WHERE p."view_id" IS NULL;
--> statement-breakpoint
-- Tables are unreadable at 1/3 width; give existing ones room.
UPDATE "dashboard_panels" SET "width" = 3 WHERE "type" = 'table' AND "width" = 1;
--> statement-breakpoint
UPDATE "dashboard_panels" SET "width" = 2 WHERE "type" IN ('timeseries', 'markdown') AND "width" = 1;
