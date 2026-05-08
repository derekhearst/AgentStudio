-- Retire the persistent tasks domain and lift artifacts to support conversation scope.
--
-- Phase 1 — drop the tasks tables and every cross-domain task_id column. Tools, subagents,
-- and chats already operate without a task row; the only remaining thing the tasks domain
-- did was annotate runs/usage/jobs/PRs/branches with a task_id. Those columns + indexes are
-- removed here.
--
-- Phase 2 — make `artifacts.project_id` nullable and add `conversation_id` so artifacts can
-- live inside a chat (lightweight in-chat plan/todo/document) without requiring a project.
--
-- Phase 3 — trim the automation_mode and automation_output_target enums (no more 'code'
-- mode, no more 'task' output target — both only existed to spawn tasks).

-- ─────────── Drop dependent task_id indexes/columns ───────────

DROP INDEX IF EXISTS "chat_runs_task_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "chat_runs_task_attempt_idx";
--> statement-breakpoint
ALTER TABLE "chat_runs" DROP COLUMN IF EXISTS "task_id";
--> statement-breakpoint
ALTER TABLE "chat_runs" DROP COLUMN IF EXISTS "task_attempt_id";
--> statement-breakpoint

DROP INDEX IF EXISTS "llm_usage_task_idx";
--> statement-breakpoint
ALTER TABLE "llm_usage" DROP COLUMN IF EXISTS "task_id";
--> statement-breakpoint

DROP INDEX IF EXISTS "tool_usage_task_idx";
--> statement-breakpoint
ALTER TABLE "tool_usage" DROP COLUMN IF EXISTS "task_id";
--> statement-breakpoint

DROP INDEX IF EXISTS "jobs_task_idx";
--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "task_id";
--> statement-breakpoint

DROP INDEX IF EXISTS "pull_requests_task_idx";
--> statement-breakpoint
ALTER TABLE "pull_requests" DROP COLUMN IF EXISTS "task_id";
--> statement-breakpoint

DROP INDEX IF EXISTS "repo_branches_task_idx";
--> statement-breakpoint
ALTER TABLE "repository_branches" DROP COLUMN IF EXISTS "task_id";
--> statement-breakpoint

ALTER TABLE "run_traces" DROP COLUMN IF EXISTS "task_id";
--> statement-breakpoint

DROP INDEX IF EXISTS "review_items_task_idx";
--> statement-breakpoint
ALTER TABLE "review_items" DROP COLUMN IF EXISTS "task_id";
--> statement-breakpoint

-- ─────────── Drop the tasks tables themselves ───────────

DROP TABLE IF EXISTS "task_attempts" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "tasks" CASCADE;
--> statement-breakpoint
DROP TYPE IF EXISTS "task_status" CASCADE;
--> statement-breakpoint
DROP TYPE IF EXISTS "task_attempt_status" CASCADE;
--> statement-breakpoint

-- ─────────── Trim automation enums ───────────
--
-- Postgres can't drop enum values directly. Recreate the enums under a temp name, ALTER the
-- column to use the new type with USING-cast, then drop the old type.

ALTER TABLE "automations" ALTER COLUMN "mode" DROP DEFAULT;
--> statement-breakpoint
ALTER TYPE "automation_mode" RENAME TO "automation_mode_old";
--> statement-breakpoint
CREATE TYPE "automation_mode" AS ENUM ('chat_followup', 'research', 'maintenance');
--> statement-breakpoint
-- Any rows still on 'code' get coerced to 'chat_followup' (the safest fallback — the only
-- effect of code-mode was to spawn a task; without tasks, falling back to chat_followup
-- means the next tick shows up in the conversation instead of vanishing silently).
ALTER TABLE "automations"
	ALTER COLUMN "mode" TYPE "automation_mode"
	USING (CASE WHEN "mode"::text = 'code' THEN 'chat_followup' ELSE "mode"::text END)::"automation_mode";
--> statement-breakpoint
ALTER TABLE "automations" ALTER COLUMN "mode" SET DEFAULT 'chat_followup';
--> statement-breakpoint
DROP TYPE IF EXISTS "automation_mode_old";
--> statement-breakpoint

ALTER TABLE "automations" ALTER COLUMN "output_target" DROP DEFAULT;
--> statement-breakpoint
ALTER TYPE "automation_output_target" RENAME TO "automation_output_target_old";
--> statement-breakpoint
CREATE TYPE "automation_output_target" AS ENUM ('chat_session', 'artifact', 'review_inbox');
--> statement-breakpoint
ALTER TABLE "automations"
	ALTER COLUMN "output_target" TYPE "automation_output_target"
	USING (CASE WHEN "output_target"::text = 'task' THEN 'chat_session' ELSE "output_target"::text END)::"automation_output_target";
--> statement-breakpoint
ALTER TABLE "automations" ALTER COLUMN "output_target" SET DEFAULT 'chat_session';
--> statement-breakpoint
DROP TYPE IF EXISTS "automation_output_target_old";
--> statement-breakpoint

-- ─────────── Lift artifacts to conversation scope ───────────

ALTER TABLE "artifacts" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "conversation_id" uuid;
--> statement-breakpoint
ALTER TABLE "artifacts"
	ADD CONSTRAINT "artifacts_conversation_id_fk"
	FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- Replace the (project_id, slug) unique constraint with a partial unique index, so each
-- scope (project / conversation) has its own slug namespace.
ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "artifacts_project_slug_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_project_slug_unique"
	ON "artifacts" ("project_id", "slug")
	WHERE "project_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_conversation_slug_unique"
	ON "artifacts" ("conversation_id", "slug")
	WHERE "conversation_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "artifacts_conversation_idx" ON "artifacts" ("conversation_id");
--> statement-breakpoint
ALTER TABLE "artifacts"
	ADD CONSTRAINT "artifacts_scope_check"
	CHECK ("project_id" IS NOT NULL OR "conversation_id" IS NOT NULL);
