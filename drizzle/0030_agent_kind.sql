-- Wave 3 #14 evaluations plan phase 1 — `agent_kind` enum + `agents.kind` column.
-- Hand-written because drizzle-kit generates a snapshot collision when an enum
-- is added alongside a column that defaults to one of its values.
DO $$ BEGIN
  CREATE TYPE "public"."agent_kind" AS ENUM('orchestrator', 'worker', 'evaluator');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "kind" "agent_kind" NOT NULL DEFAULT 'worker';
