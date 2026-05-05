-- Wave 5 #21 phase 4 (code-mode finish) — `automations.repository_id` column.
--
-- Code-mode automations (mode='code') need a target repository so the runner can
-- materialize a worktree before invoking the agent loop. We declare the column by-name
-- (no enforced FK) for the same reason `tasks.repository_id` does — deleting the repo
-- shouldn't cascade-wipe automation history; the runner falls back to chat_followup
-- behavior with a clear log when the linked repo is gone.

ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "repository_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_repository_idx" ON "automations" ("repository_id");
