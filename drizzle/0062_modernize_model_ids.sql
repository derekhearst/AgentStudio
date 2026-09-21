-- Retire OpenRouter-style Anthropic model ids.
--
-- Every model used to be routed through OpenRouter, so ids were stored vendor-prefixed
-- (`anthropic/claude-sonnet-4`). The Agent SDK takes the bare id, and more importantly the
-- models those ids name are retired — the CLI answers "it may not exist or you may not have
-- access to it". Left alone, every pre-existing conversation fails on its first turn after
-- the engine migration.
--
-- Mapping keeps the tier so cheap workers stay cheap:
--   anthropic/claude-sonnet-4    -> claude-sonnet-5
--   anthropic/claude-sonnet-4-6  -> claude-sonnet-5
--   anthropic/claude-opus-4      -> claude-opus-5
--   anthropic/claude-haiku-4.5   -> claude-haiku-4-5
--
-- Non-Anthropic ids are deliberately untouched. `moonshotai/...` and friends still need the
-- Anthropic-compatible gateway, and failing loudly on those is the intended behaviour until
-- one is configured. openai/* and google/* ids here are embeddings, transcription and TTS,
-- which still go through OpenRouter and are unaffected by the chat engine.

-- ─────────── Column defaults ───────────

ALTER TABLE "conversations" ALTER COLUMN "model" SET DEFAULT 'claude-sonnet-5';
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "model" SET DEFAULT 'claude-sonnet-5';
--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "default_model" SET DEFAULT 'claude-sonnet-5';
--> statement-breakpoint

-- ─────────── Existing rows ───────────

UPDATE "conversations" SET "model" = 'claude-sonnet-5'
	WHERE "model" IN ('anthropic/claude-sonnet-4', 'anthropic/claude-sonnet-4-6');
--> statement-breakpoint
UPDATE "conversations" SET "model" = 'claude-opus-5' WHERE "model" = 'anthropic/claude-opus-4';
--> statement-breakpoint

UPDATE "agents" SET "model" = 'claude-sonnet-5'
	WHERE "model" IN ('anthropic/claude-sonnet-4', 'anthropic/claude-sonnet-4-6');
--> statement-breakpoint
UPDATE "agents" SET "model" = 'claude-opus-5' WHERE "model" = 'anthropic/claude-opus-4';
--> statement-breakpoint

UPDATE "app_settings" SET "default_model" = 'claude-sonnet-5'
	WHERE "default_model" IN ('anthropic/claude-sonnet-4', 'anthropic/claude-sonnet-4-6');
--> statement-breakpoint

-- The rerank model lives inside a jsonb blob rather than its own column.
UPDATE "app_settings"
	SET "memory_config" = jsonb_set("memory_config", '{rerankModel}', '"claude-haiku-4-5"')
	WHERE "memory_config" ->> 'rerankModel' LIKE 'anthropic/%';

-- Historical `messages.model` values are left as written. They are a record of what actually
-- answered at the time, not configuration, and rewriting them would falsify the transcript.
