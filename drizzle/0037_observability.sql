-- Wave 5 #20 phase 1 — observability + review inbox foundation.
DO $$ BEGIN
  CREATE TYPE "public"."run_trace_status" AS ENUM('running', 'completed', 'failed', 'canceled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."review_item_type" AS ENUM(
    'approval_request', 'user_question', 'evaluation_failure',
    'job_failure', 'job_stuck', 'hook_failure',
    'artifact_conflict', 'memory_conflict', 'policy_override_request'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."review_item_status" AS ENUM('open', 'in_progress', 'resolved', 'dismissed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."review_item_severity" AS ENUM('info', 'warning', 'critical');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_traces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "session_id" uuid,
  "task_id" uuid,
  "job_id" uuid,
  "trace" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "status" "run_trace_status" DEFAULT 'running' NOT NULL,
  "tool_call_count" integer DEFAULT 0 NOT NULL,
  "round_count" integer DEFAULT 0 NOT NULL,
  "cost_usd" numeric(12, 4) DEFAULT '0' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" "review_item_type" NOT NULL,
  "status" "review_item_status" DEFAULT 'open' NOT NULL,
  "severity" "review_item_severity" DEFAULT 'warning' NOT NULL,
  "run_id" uuid,
  "session_id" uuid,
  "task_id" uuid,
  "job_id" uuid,
  "project_id" uuid,
  "artifact_id" uuid,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "summary" text,
  "assigned_to" uuid,
  "resolved_by" uuid,
  "resolution" jsonb,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operational_metrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "metric" text NOT NULL,
  "dimension" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "value" numeric(18, 6) NOT NULL,
  "measured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_assigned_to_users_id_fk"
  FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_resolved_by_users_id_fk"
  FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_traces_run_idx" ON "run_traces" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_traces_status_idx" ON "run_traces" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_traces_started_idx" ON "run_traces" USING btree ("started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_items_type_status_idx" ON "review_items" USING btree ("type", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_items_status_severity_idx" ON "review_items" USING btree ("status", "severity");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_items_assigned_idx" ON "review_items" USING btree ("assigned_to");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_items_run_idx" ON "review_items" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_items_task_idx" ON "review_items" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_items_job_idx" ON "review_items" USING btree ("job_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_items_created_idx" ON "review_items" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operational_metrics_metric_measured_idx" ON "operational_metrics" USING btree ("metric", "measured_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operational_metrics_measured_idx" ON "operational_metrics" USING btree ("measured_at");
