-- Phase 46 — seed a "wp-sites" scoped operator playbook that makes the
-- Divi-5-only builder policy STANDING knowledge for every WordPress workspace,
-- and codifies the "DiviOps looks down = rename the connection, don't switch
-- builders" diagnosis. Written after a live migration run (Copetown United
-- Church → build-1) where the operator agent repeatedly (a) got confused about
-- whether Kadence/Gutenberg/Oxygen were still options — they are not, retired
-- per 0025/0026 — and (b) read the registry's old "tool names too long"
-- failedConnections line as "DiviOps is down / infrastructure", then offered to
-- switch the client to a different page builder. Both are knowledge gaps a
-- playbook fixes without a deploy (reaches the agent on its next turn via
-- loadPlaybooksFor(), scope 'wp-sites').
--
-- The load-bearing MCP-name fix ships in code (registry.ts describeSkippedTools
-- + connectionNameFitsTools, /api/plugins + /api/mcp/connections guards); this
-- playbook is the human-facing half so the agent NARRATES the right thing.
--
-- Idempotent (no unique constraint on scope+title to hang ON CONFLICT off of,
-- so guard with NOT EXISTS instead — same pattern as 0020–0026).
INSERT INTO "playbooks" ("scope", "title", "body")
SELECT
	'wp-sites',
	'Builder policy — Divi 5 only',
	$BODY$Builder policy for this platform — read before starting ANY build or Duda→WordPress migration.

DIVI 5 IS THE ONLY BUILDER. Kadence, Gutenberg-blocks-as-a-builder, Oxygen and Elementor are all RETIRED (Kadence/Gutenberg retired in favour of Divi with the unlimited licence; Oxygen retired before that). Do NOT propose one, "fall back to" one, or ask which builder to use — even if a build site once ran Kadence/Oxygen, a page's stored content looks like plain Gutenberg, or an older note/manifest mentions "the Gutenberg/Kadence playbook". Any extraction manifest that says it "feeds the Gutenberg/Kadence playbook" is stale wording: the same design-tokens + page-sections JSON now feeds the DIVI 5 build (design tokens → Divi Theme Builder global styles / presets, not Kadence Global Palette). Every build site (build-1 … build-N) is Divi 5.

GOOD NEWS — Divi 5 uses the SAME read/write channel. Divi 5 stores native Gutenberg blocks (wp:divi/section, wp:divi/row, …) in post_content, so wp_content_get / wp_content_update read and write it directly. Seeing block markup on a page is NOT evidence the site is "Kadence/Gutenberg, not Divi" — check the active theme/plugin (Divi 5.x) instead of guessing from the markup shape.

IF DiviOps' TOOLS ARE MISSING THIS TURN — IT IS ALMOST CERTAINLY A NAME LENGTH ISSUE, NOT AN OUTAGE. The model API caps every tool name at 64 characters, and tools are namespaced mcp__<connection>__<tool>. DiviOps' longest tool (diviops_variable_create_fluid_system, 36 chars) plus the 7-char wrapper means a DiviOps connection name must be ≤ 21 characters or its longest tools silently drop and the request is rejected — which looks exactly like "the server is down". The [system] unavailability note now tells you this verbatim and gives the fix. THE FIX IS TO RENAME THE CONNECTION, e.g. name it after the site label: "diviops-build-1" (15 chars ✓), never "diviops-build-churchwebglobal-com" (33 chars ✗). When you create a DiviOps connection, bind it to a WordPress Sites label (POST /api/plugins { wpSiteLabel: "build-1" }) so it is auto-named diviops-<label> and short by construction. NEVER treat missing DiviOps tools as a reason to switch builders, wait for "infrastructure", or tell the operator a product is down — say the connection name is too long and needs renaming, and continue in Divi 5.

DON'T CLAIM WORK YOU DIDN'T DO. Only report data from tool calls that actually returned; never write out a tool's result as prose you expect to be true. An extraction/build is not "complete" until its images are re-hosted on the target site (wp_upload_media — Duda CDN URLs die at cutover) and the page passes a real render check; a saved manifest whose image step failed is NOT a green Phase 5.$BODY$
WHERE NOT EXISTS (
	SELECT 1 FROM "playbooks" WHERE "scope" = 'wp-sites' AND "title" = 'Builder policy — Divi 5 only'
);
