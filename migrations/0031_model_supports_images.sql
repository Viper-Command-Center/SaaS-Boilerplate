-- Phase 48.3 — model_catalog gains `supports_images` (vision capability).
-- Hand-written, idempotent (same pattern as 0024/0029/0030): ADD COLUMN IF NOT
-- EXISTS + guarded UPDATEs, safe to re-run.
--
-- Why: a workspace's assigned CHAT model may be a text-only Mantle model
-- (Kimi/DeepSeek/etc.). When Ryan pasted a screenshot, the turn sent an image
-- block and Bedrock Mantle 400'd the WHOLE turn ("Model does not support image
-- modality") — he couldn't even communicate. This flag lets the platform DROP
-- images with an honest note for a text-only model instead of failing the turn.
-- Defaults FALSE (safe: unknown models are treated as text-only and images are
-- dropped-with-note rather than risked); the Claude families we ship are flipped
-- to TRUE below since they are multimodal.

ALTER TABLE "model_catalog" ADD COLUMN IF NOT EXISTS "supports_images" boolean NOT NULL DEFAULT false;

-- Claude (Anthropic) models on Mantle are multimodal. Match the ids/families we
-- seed and anything an admin later adds whose id marks it as a Claude model.
UPDATE "model_catalog"
SET "supports_images" = true
WHERE "provider" = 'anthropic' OR "id" ILIKE '%claude%';
