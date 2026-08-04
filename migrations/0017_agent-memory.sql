-- Phase 28: standing workspace memory — durable facts auto-injected into the
-- agent's system prompt every turn (the CLAUDE.md / Hindsight-lite pattern).
-- Hand-written, idempotent: safe to re-run.

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "agent_memory" text;
