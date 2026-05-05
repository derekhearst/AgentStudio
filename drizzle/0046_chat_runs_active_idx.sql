-- Partial index for unfinished chat_runs.
--
-- Three production queries match this exact shape and currently fall back to either the
-- single-column `state` index (low selectivity — most rows are `completed`) or `updated_at`
-- (low selectivity — sorted by recency anyway):
--
--   1. `reapStuckRuns` (runs.server.ts) — WHERE finished_at IS NULL AND state IN (...) AND updated_at < cutoff
--   2. `getConversation` (chat.remote.ts) — WHERE conversation_id = ? AND user_id = ? AND finished_at IS NULL
--   3. `listActiveChatRunsForUser` (runs.server.ts) — WHERE user_id = ? AND finished_at IS NULL AND state IN (...)
--
-- The partial-index predicate `WHERE finished_at IS NULL` keeps the index tiny — only live
-- runs are indexed, which is a small fraction of `chat_runs`. Cost to add now: a few ms on
-- migrate; cost to skip: every reaper tick + every chat-detail page load does extra work
-- once the table grows past ~100k rows.

CREATE INDEX IF NOT EXISTS "chat_runs_active_updated_idx"
	ON "chat_runs" ("updated_at" DESC)
	WHERE "finished_at" IS NULL;
