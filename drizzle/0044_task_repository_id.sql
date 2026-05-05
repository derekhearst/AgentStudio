-- Wave 5 #19 phase 2 finish — `tasks.repository_id` column.
--
-- Repo-backed tasks: when this column is set, the task runner provisions a real worktree
-- against the linked repository's local mirror before invoking runChatLoop. The agent
-- gets a `${workspace}/worktrees/<runId>` checkout on a per-task branch instead of the
-- generic per-user sandbox.
--
-- Declared by-name (no enforced FK) so deleting a repository doesn't cascade-delete tasks
-- — the runner falls back to the legacy non-repo workspace if the row is gone, and an
-- operator can re-attach the task to a different repo without touching task history.

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "repository_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_repository_idx" ON "tasks" ("repository_id");
