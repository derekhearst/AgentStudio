-- Long-horizon monitors (issue #33).
--
-- Automations answer "run this every N". A monitor answers "watch for X and act when it
-- happens": a stored condition, a check interval, a deadline, and an action. The durable job
-- queue does the waking (`monitors_dispatch` every 60s enqueues a `monitor_check` per due
-- monitor); this table holds the standing intent plus the state that makes "changed since
-- last check" and "fire once per change" work.
--
-- Everything below is additive and idempotent: new enum types guarded by duplicate_object,
-- CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and ADD VALUE IF NOT EXISTS on the
-- existing review_item_type enum (same shape as 0052). No existing row is touched and no
-- existing column changes type, so a re-run is a no-op and a rollback to the previous image
-- keeps working against this schema.
--
-- Two caps are NOT NULL on purpose. `deadline_at` has no "never" value -- a monitor with no
-- deadline is a memory leak with a bill attached -- and `max_checks` bounds spend for the
-- model-question conditions, which pay for a cheap LLM call on every single check.

DO $$ BEGIN
  CREATE TYPE "public"."monitor_status" AS ENUM ('active', 'paused', 'fired', 'expired', 'exhausted', 'failed', 'canceled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."monitor_condition_kind" AS ENUM ('tool_result', 'model_question');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."monitor_action" AS ENUM ('start_conversation', 'review_item', 'push', 'run_automation');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- A fired monitor lands in the review inbox under its own type rather than borrowing
-- `automation_summary`, which would read as a lie in the UI. Additive enum value; the new
-- value is not referenced anywhere else in this migration, which is what keeps the
-- ALTER TYPE safe inside the migrator's transaction.
ALTER TYPE "public"."review_item_type" ADD VALUE IF NOT EXISTS 'monitor_fired';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monitors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "agent_id" uuid,
  "name" text NOT NULL,
  "status" "monitor_status" DEFAULT 'active' NOT NULL,
  "condition_kind" "monitor_condition_kind" NOT NULL,
  "condition" jsonb NOT NULL,
  "action" "monitor_action" NOT NULL,
  "action_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "interval_seconds" integer DEFAULT 900 NOT NULL,
  "deadline_at" timestamp with time zone NOT NULL,
  "max_checks" integer DEFAULT 200 NOT NULL,
  "check_count" integer DEFAULT 0 NOT NULL,
  "next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_checked_at" timestamp with time zone,
  "last_observation" jsonb,
  "condition_met" boolean DEFAULT false NOT NULL,
  "fire_count" integer DEFAULT 0 NOT NULL,
  "last_fired_at" timestamp with time zone,
  "last_fire_result" jsonb,
  "consecutive_errors" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "one_shot" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "monitors" ADD CONSTRAINT "monitors_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "monitors" ADD CONSTRAINT "monitors_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- The dispatcher's only query path: active monitors whose next check is due.
CREATE INDEX IF NOT EXISTS "monitors_due_idx" ON "monitors" USING btree ("status", "next_check_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitors_user_idx" ON "monitors" USING btree ("user_id");
--> statement-breakpoint
-- The per-tick deadline sweep, so an expired monitor stops being checked within a minute of
-- its deadline regardless of how long its own interval is.
CREATE INDEX IF NOT EXISTS "monitors_deadline_idx" ON "monitors" USING btree ("deadline_at");
