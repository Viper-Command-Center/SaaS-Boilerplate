-- Phase 43 — AI model catalog (Bedrock Mantle). Hand-written, idempotent
-- (same reason as 0020/0021/0022): CREATE TABLE IF NOT EXISTS + ON CONFLICT
-- DO NOTHING seed rows, safe to re-run.
--
-- Seed prices are USD per 1M tokens, captured live from the Bedrock Mantle
-- console on 2026-09-12 — re-check against the console before trusting them
-- months from now, prices move. toolUseVerified is FALSE for every row on
-- purpose: none of these have been confirmed with a real mission test yet.
CREATE TABLE IF NOT EXISTS "model_catalog" (
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"provider" varchar(40) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"api_format" varchar(20) DEFAULT 'anthropic' NOT NULL,
	"input_price_per_m" numeric(10, 4) NOT NULL,
	"output_price_per_m" numeric(10, 4) NOT NULL,
	"context_window" integer,
	"max_output_tokens" integer,
	"supports_reasoning" boolean DEFAULT false NOT NULL,
	"tool_use_verified" boolean DEFAULT false NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_catalog_active_idx" ON "model_catalog" USING btree ("active","api_format");
--> statement-breakpoint
INSERT INTO "model_catalog"
	("id", "provider", "display_name", "api_format", "input_price_per_m", "output_price_per_m", "supports_reasoning", "notes")
VALUES
	('anthropic.claude-opus-5', 'anthropic', 'Claude Opus 5', 'anthropic', 5.00, 25.00, true, 'Highest-capability Claude tier. Use for the hardest build work only — most sites should use Sonnet 5.'),
	('anthropic.claude-sonnet-5', 'anthropic', 'Claude Sonnet 5', 'anthropic', 2.00, 10.00, true, 'Platform default for build/mission work.'),
	('anthropic.claude-haiku-4-5', 'anthropic', 'Claude Haiku 4.5', 'anthropic', 1.10, 5.50, true, 'Cheap, fast Claude tier — good chat-only default.'),
	('moonshotai.kimi-k2.5', 'moonshotai', 'Kimi K2.5', 'openai', 0.60, 3.00, false, 'Tool-use reliability not yet verified against this platform — test before trusting for build work.'),
	('deepseek.v3.2', 'deepseek', 'DeepSeek V3.2', 'openai', 0.62, 1.85, false, 'Console shows no reasoning/feature flags. Cheapest general-purpose option — good chat candidate once tool-use is verified.'),
	('nvidia.nemotron-super-3-120b', 'nvidia', 'NVIDIA Nemotron 3 Super 120B', 'openai', 0.15, 0.65, false, 'Very cheap. Tool-use reliability not yet verified.'),
	('zai.glm-5', 'zai', 'GLM 5', 'openai', 1.00, 3.20, false, 'Tool-use reliability not yet verified.'),
	('qwen.qwen3-coder-next', 'qwen', 'Qwen3 Coder Next', 'openai', 0.50, 1.20, false, 'Coding-tuned. Worth testing for WordPress/Kadence build work specifically.'),
	('xai.grok-4.3', 'xai', 'Grok 4.3', 'openai', 1.25, 2.50, true, 'Supports reasoning_effort (none/low/medium/high). Tool-use reliability not yet verified.'),
	('openai.gpt-5.6-luna', 'openai', 'GPT-5.6 Luna', 'openai', 0.22, 1.32, false, 'Cheapest chat-tier candidate. Tool-use reliability not yet verified.')
ON CONFLICT ("id") DO NOTHING;
