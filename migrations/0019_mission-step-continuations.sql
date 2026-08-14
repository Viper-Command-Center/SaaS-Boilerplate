-- Phase 34: bound mission-step continuations.
--
-- A step that exhausted its tool budget was kept 'running' and resumed on the
-- next tick — correct for long work, but with no ceiling. A step that exhausts
-- EVERY tick therefore never fails and never finishes: the mission sits at
-- 'running' forever, consuming budget each tick and blocking other missions.
-- `attempts` could not serve here; it counts failures, and exhaustion is not
-- one. Hand-written, idempotent.

ALTER TABLE "mission_steps" ADD COLUMN IF NOT EXISTS "continuations" integer DEFAULT 0 NOT NULL;
