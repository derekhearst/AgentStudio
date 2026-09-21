-- Claude Agent SDK session id on conversations.
--
-- The engine migration hands turn-to-turn conversation state to the Agent SDK. Instead of
-- rebuilding the full message history from `messages` on every request and re-running our
-- own compaction and tool-result trimming, a follow-up turn resumes the SDK session that
-- produced the previous turn.
--
-- Nullable on purpose, with two distinct meanings for NULL:
--   * conversations created before this migration — they have no SDK session, so the next
--     turn starts a fresh one (their prior history stays readable in `messages`, it just
--     isn't replayed into the SDK)
--   * brand new conversations, until the first run reports its session id
--
-- `messages` remains the source of truth for what the UI renders and for branching/edit
-- flows. This column only tracks where the SDK's own state lives.

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "sdk_session_id" text;
