-- Phase 47.2 — Site Chat "Start New Conversation": archive a speaker's active
-- thread instead of forever appending to one. Kept (never deleted); NULL = the
-- active thread for that (site_id, external_key). Hand-written, idempotent.
--
-- REQUIRED BY: src/models/Schema.ts (conversations.archivedAt) and
-- src/libs/sitechat/turns.ts, which filter `isNull(conversations.archivedAt)`
-- on EVERY site-chat poll/send. Without this column the query throws
-- `column "archived_at" does not exist` and all site chat fails.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
