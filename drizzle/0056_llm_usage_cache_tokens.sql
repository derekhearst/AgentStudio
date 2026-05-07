-- Anthropic prompt-caching token columns on llm_usage.
--
-- When chats run against Anthropic models with `cache_control` markers (set on the system
-- prompt and the last tool definition in stream/+server.ts and runtime/loop.server.ts),
-- OpenRouter forwards the marker and exposes detailed cache metrics on the usage payload.
-- These columns capture the breakdown so cost analysis can distinguish cached from
-- uncached input tokens. tokens_in still represents the gross prompt count; the new
-- columns are subsets isolated for reporting.
--
-- Both columns default to 0 — non-Anthropic providers (or runs predating this change)
-- simply leave them at 0.

ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "tokens_cache_write" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "tokens_cache_read" integer DEFAULT 0 NOT NULL;
