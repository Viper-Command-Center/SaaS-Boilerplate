-- Draft receipts survive model turns and redeploys. No live pages are mutated by this migration.
CREATE TABLE IF NOT EXISTS "divi_site_designs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "mcp_connections"("id") ON DELETE CASCADE,
  "target" text NOT NULL,
  "design" jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "divi_site_designs_connection_uq" ON "divi_site_designs" ("tenant_id", "connection_id");

CREATE TABLE IF NOT EXISTS "divi_builds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "mcp_connections"("id") ON DELETE CASCADE,
  "build_key" varchar(120) NOT NULL,
  "target" text NOT NULL,
  "plan" jsonb NOT NULL,
  "page_id" integer,
  "status" varchar(30) DEFAULT 'planned' NOT NULL,
  "receipt" jsonb,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "divi_builds_key_uq" ON "divi_builds" ("tenant_id", "connection_id", "build_key");

-- Supersede ceremonial lookup/duplicate validation requirements in seeded playbooks.
UPDATE "playbooks" SET "body" = "body" || E'\n\nDIVI BUILD PIPELINE UPDATE (overrides older workflow instructions above): Agency builds use divi_build_draft with a compact page plan and a stable build_key; divi_build_status resumes the receipt. Presets are OPTIONAL: explicit native styles are supported. Reference lookups are advisory for unfamiliar custom paths, not required for validated patterns. Local write validation is automatic; do not add a separate validate_blocks round trip for pipeline output. Build whole draft pages or substantial batches; do not re-discover templates for every module. The structure check proves HTML structure only, never image loading or visual quality. Use divi_verify_draft at a page checkpoint, then visually review screenshots; keep drafts unpublished. Client site chat is for scoped edits, not agency design-system setup. Stop after repeated connection failures and preserve the receipt; never blindly retry an uncertain create/append.'
WHERE "scope" = 'wp-sites' AND "title" IN ('Divi 5 conventions', 'Verify before you claim, and work efficiently', 'Builder policy — Divi 5 only')
AND position('DIVI BUILD PIPELINE UPDATE' in "body") = 0;