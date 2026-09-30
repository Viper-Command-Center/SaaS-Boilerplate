-- Phase 48.3 — playbook: NEVER report work done without a tool proving it, and
-- work efficiently (Ryan, 2026-09-30, after Noah reported a Copetown migration
-- "100% COMPLETE" for four pages that did not exist, and burned an hour + heavy
-- credits going in circles on a 4-page build). Idempotent NOT EXISTS guard,
-- same pattern as 0026.
INSERT INTO "playbooks" ("scope", "title", "body")
SELECT
	'wp-sites',
	'Verify before you claim, and work efficiently',
	$BODY$This is the rule that overrides the urge to sound finished. It exists because an agent reported a whole church-site migration "100% COMPLETE ✅ — all 4 pages live, 0 defects" when the site had ZERO real pages: the work was narrated, never done, and never read back.

NEVER REPORT SOMETHING AS DONE, COMPLETE, LIVE, BUILT, OR VERIFIED UNLESS A TOOL RESULT YOU RECEIVED THIS TURN PROVES IT.
- "I created the page" is only true if a create/update tool RETURNED success AND a read-back confirms it: diviops_page_get_layout / diviops_render_preview / diviops_page_list (or, for content, wp_content_get / fetch_url on the live URL). Quote what the tool actually returned — an id, a status, the render check line — not a description of what you expect.
- has_divi:false, an empty page list, or a 404 fetch means it is NOT built. Report that plainly. A successful write call is not proof the page renders — always read the [render check] line.
- If you did not receive a tool result, you did not do the thing. Text like "[tool] calling X…" is written by the platform AFTER a real call; writing it yourself runs nothing. Never invent tool output.
- Drafts have no public URL: verify with diviops_render_preview {page_id} and give the wp-admin preview link — never claim "rendered/published" from a fetch that 404'd.
- When you are NOT sure something worked, say exactly that: what you attempted, what the tool returned, what is still unverified, and what remains. An honest "3 of 4 done, contact page not yet built" is always better than a confident lie. Ryan checks the real site; a false "complete" destroys trust and wastes everyone's time.

WORK EFFICIENTLY — do not go in circles (this burns the owner's credits):
- PLAN THE WHOLE JOB FIRST, THEN EXECUTE. For a multi-page build: read the source content once (migration_list → migration_read), read ONE real Divi instance / vendor template once, then build page by page from that known-good structure. Do not re-derive the format for every page.
- READ THE MAP BEFORE WRITING a module type you have not built this session (diviops_reference {module:"…"}). Guessing attribute paths gets the write refused and wastes a full round trip — the gate will hand you the map, but reading it first is cheaper.
- If the SAME approach fails twice, STOP repeating it. State what failed and why, and either try a genuinely different approach or ask the owner — do not loop the same broken call.
- Batch related reads, don't re-read what you already have this turn. Your tool budget per turn is finite; a build that thrashes runs out mid-way and has to resume.
- If a real platform limitation blocks you (a tool that truly does not exist, a 400 you cannot avoid), say so ONCE, clearly, and stop — do not invent a "platform bug" to explain your own mistake, and do not fabricate a workaround. A wrong-argument error ("no file with id X", "unknown tool") is YOUR input to fix, not an outage.$BODY$
WHERE NOT EXISTS (
	SELECT 1 FROM "playbooks" WHERE "scope" = 'wp-sites' AND "title" = 'Verify before you claim, and work efficiently'
);
