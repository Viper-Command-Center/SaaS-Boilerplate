ALTER TABLE "mcp_connections" ADD COLUMN "catalog_id" uuid;--> statement-breakpoint
ALTER TABLE "plugin_catalog" ADD COLUMN "provider" varchar(60);