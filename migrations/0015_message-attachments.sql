-- Phase 23 — image attachments on agent chat messages.
--
-- Hand-written and idempotent, per the established pattern in this repo: the
-- Cowork sandbox reads mounted files unreliably (virtiofs serves truncated
-- copies of freshly-edited files), so drizzle-kit cannot see the real Schema.ts
-- and would generate from a stale snapshot.
--
-- Stores file IDs, not bytes. The images live in R2 and are indexed in `files`;
-- putting base64 here would bloat the conversation table for no gain. No FK to
-- `files` on purpose: a deleted file should leave the message intact — vision.ts
-- renders an honest "no longer available" marker rather than the row failing.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments jsonb;
