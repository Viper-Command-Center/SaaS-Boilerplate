-- Phase 48.4 — the end-to-end Duda→WordPress→Divi 5 migration procedure, as a
-- single ordered playbook (Ryan, 2026-09-30, overnight autonomous pass). The
-- agent kept going in circles on migrations because no one document tied the
-- pieces together: where the extracted content lives, which order to build in,
-- and when a step is actually "done". This is that map. Idempotent NOT EXISTS
-- guard, same pattern as 0026/0032.
INSERT INTO "playbooks" ("scope", "title", "body")
SELECT
	'wp-sites',
	'Duda to WordPress (Divi 5) migration — the procedure',
	$BODY$How to migrate a Duda site to WordPress + Divi 5 without going in circles. Read this once at the start of a migration and follow it in order. Pair it with the "Divi 5 conventions" and "Verify before you claim" playbooks — this one is the workflow; those are the rules.

WHERE THE SOURCE CONTENT LIVES (this is what tripped past attempts)
A migration's extracted content is NOT in the file library — read_file cannot see it. It is in the migration job's own store. Use these tools:
- migration_list  (no arguments) → find the job id for this site.
- migration_list {jobId}          → list every extracted file (pages, posts, collections, design brief, media manifest) with its path + status.
- migration_read {jobId, path}    → read one file's real text (e.g. "pages/home.md", "design/current-design.md", "media/manifest.json"). This is your source of truth for content, palette, fonts and image URLs. Quote what it returns; never invent content or a colour palette.

THE BUILD ORDER — do these once each, in this sequence, then repeat step 6 per page
1. READ THE PLAN. migration_list {jobId} to see the full file set. Read 00-overview and design/current-design.md first so you know the palette, fonts and page inventory BEFORE building anything. Use the REAL extracted palette/fonts, not values you imagine.
2. STARTING STRUCTURE. Prefer an existing, well-built Divi 5 instance as your base: check diviops_library_list / diviops_template_list for a saved layout or vendor starter that fits, and diviops_page_get_layout on any real page already on the site. Editing a known-good structure beats hand-writing markup ("read a real instance first").
3. READ THE MODULE MAPS you will use, once: diviops_reference {module:"Heading"} etc. — one call per module type. Build only from documented attribute paths; the gate refuses guesses.
4. MEDIA FIRST. Upload the images this build needs to the WordPress media library (wp_upload_media) and use the returned SITE urls in the markup. Divi cannot reference workspace-library or Duda-CDN urls (they die at cutover / are private). Do this before building pages that reference them. Watch the per-turn budget: if there are many images, upload in a batch, note the returned ids, and continue.
5. NAV / THEME once. Build the header/footer in Theme Builder ONCE (not per page) if the design needs a shared nav.
6. BUILD ONE PAGE AT A TIME. For each page (home, about, services, contact…): map the migration_read content into the structure from step 2 → diviops_validate_blocks → write (diviops_page_create / section_append / page_update_content) → READ THE [render check] line → diviops_render_preview {page_id} to confirm it actually renders → only then move to the next page. If a write is refused, read the inlined map, fix the exact path, and retry — do not fall back to a Code/raw-HTML module.
7. VERIFY THE SITE. diviops_page_list to confirm every intended page exists and is the right status; spot-check contrast/responsive with a render preview. has_divi:false or a missing page means it is NOT done.

BUDGET & EFFICIENCY (this is real money)
- A full 4-page build is large. If you approach the per-turn tool budget, STOP at a clean point, report exactly which pages are built-and-verified vs. remaining, and continue next turn — do not thrash.
- Do not re-read files you already read this turn. Do not re-derive the module format for every page — read it once, reuse it.
- If the same call fails twice, change approach or ask; never loop it.

WHAT "DONE" MEANS
A page is done only when a tool result proves it: a successful write AND a render_preview/page_get_layout that shows real Divi content. Report per the "Verify before you claim" rule — quote the tool output, never a description. An honest "3 of 4 pages built and verified, contact page remaining" is correct; "migration complete" for unverified pages is the exact failure this platform now blocks.$BODY$
WHERE NOT EXISTS (
	SELECT 1 FROM "playbooks" WHERE "scope" = 'wp-sites' AND "title" = 'Duda to WordPress (Divi 5) migration — the procedure'
);
