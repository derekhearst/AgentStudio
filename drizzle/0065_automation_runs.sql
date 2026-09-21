-- Automation run history + failure state (issue #31).
--
-- Before this, an automation row carried last_run_at / next_run_at and nothing else: there
-- was no way to see whether a past run worked, what it produced, or why it failed. This
-- migration adds the run ledger and the two columns the failure policy needs.
--
-- Why a table rather than a join over chat_runs: a chat_run only exists for the
-- agent-attached chat_followup path. Maintenance ticks, research ticks, the no-agent
-- synthesis path, and every failure that happens before a mode handler is reached (budget
-- block, missing agent, bad cron) produce no chat_run at all — so a join could only ever
-- show a subset of runs, and never the failures, which are the interesting ones.
--
-- Additive and idempotent only. Nothing is dropped, renamed, or rewritten; the app runs
-- pending migrations at boot, so a partially-applied re-run has to be a no-op:
--   * new columns use ADD COLUMN IF NOT EXISTS with defaults, so existing rows backfill
--     to "no failures yet, not disabled by the system"
--   * the new table is CREATE TABLE IF NOT EXISTS, its FKs are guarded against
--     duplicate_object, and its indexes use IF NOT EXISTS
--   * status / trigger are text, not enums, deliberately — no new pg type to create, and
--     no ALTER TYPE ... ADD VALUE to sequence against a transaction-wrapped migrator

ALTER TABLE "automations"
	ADD COLUMN IF NOT EXISTS "consecutive_failures" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "automations"
	ADD COLUMN IF NOT EXISTS "disabled_reason" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"user_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'chat_followup' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"conversation_id" uuid,
	"chat_run_id" uuid,
	"research_id" uuid,
	"job_id" uuid,
	"cost_usd" numeric(18, 12),
	"error" text,
	"output_excerpt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk"
		FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id")
		ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_user_id_users_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
		ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- conversation_id / chat_run_id / research_id / job_id are deliberately FK-free pointers,
-- matching the jobs table: the ledger outlives the artifacts it points at, and a cascade
-- from a GC'd conversation would delete the very history an operator is looking for.
CREATE INDEX IF NOT EXISTS "automation_runs_automation_idx"
	ON "automation_runs" USING btree ("automation_id", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_runs_status_idx"
	ON "automation_runs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_runs_started_idx"
	ON "automation_runs" USING btree ("started_at");
