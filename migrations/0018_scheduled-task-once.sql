-- Phase 33: one-shot scheduled tasks.
--
-- Scheduled tasks were interval-only: nextRunAt defaults to now() and every run
-- pushes it forward by intervalMinutes, forever. That is right for standing
-- missions ("publish a post every Monday") and wrong for anything genuinely
-- one-off — most obviously a scheduled EMAIL, which Postmark cannot schedule
-- itself, so it has to become a task. Repeating a one-off send on an interval
-- would re-mail the list every cycle.
--
-- run_once = fire at next_run_at, then disable. Hand-written, idempotent.

ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "run_once" boolean DEFAULT false NOT NULL;
