-- Phase 48.8 — live sub-step progress for the missions meter.
--
-- Mission steps run in the background for minutes; a progress bar that only
-- moves when a WHOLE step finishes looks frozen ("it's stuck"). These three
-- nullable columns let the runner write the current tool-loop iteration on
-- every onProgress ping, so the UI can show a real within-step fraction that
-- advances while the agent is working.
--
-- Hand-written + idempotent (the standing 0010+ rule: NOT drizzle-kit generate),
-- and journaled as idx 34 — an un-journaled migration is skipped by
-- drizzle-kit migrate (this landmine bit on 0028 and again on 0031-33).

ALTER TABLE "mission_steps" ADD COLUMN IF NOT EXISTS "progress_iterations" integer;
ALTER TABLE "mission_steps" ADD COLUMN IF NOT EXISTS "progress_max" integer;
ALTER TABLE "mission_steps" ADD COLUMN IF NOT EXISTS "progress_note" text;
