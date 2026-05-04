-- Wave 4 #17 phase 1 — durable job queue: jobs + jobPolicies + jobLeases.
DO $$ BEGIN
  CREATE TYPE "public"."job_status" AS ENUM('pending', 'leased', 'running', 'retry_wait', 'completed', 'failed', 'canceled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" text NOT NULL,
  "status" "job_status" DEFAULT 'pending' NOT NULL,
  "priority" integer DEFAULT 100 NOT NULL,
  "queue" text DEFAULT 'default' NOT NULL,
  "dedupe_key" text,
  "scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 3 NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "result" jsonb,
  "error" jsonb,
  "run_id" uuid,
  "task_id" uuid,
  "session_id" uuid,
  "project_id" uuid,
  "user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "jobs_type_dedupe_unique" UNIQUE("type", "dedupe_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_type" text NOT NULL UNIQUE,
  "max_attempts" integer DEFAULT 3 NOT NULL,
  "backoff_ms" integer DEFAULT 5000 NOT NULL,
  "concurrency_key" text,
  "concurrency_limit" integer,
  "timeout_ms" integer DEFAULT 60000 NOT NULL,
  "cancel_behavior" text DEFAULT 'best_effort' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" uuid NOT NULL,
  "worker_id" text NOT NULL,
  "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_leases" ADD CONSTRAINT "job_leases_job_id_jobs_id_fk"
  FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_claim_idx" ON "jobs" USING btree ("status", "scheduled_at", "priority");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_queue_idx" ON "jobs" USING btree ("queue", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_type_idx" ON "jobs" USING btree ("type", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_run_idx" ON "jobs" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_task_idx" ON "jobs" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_user_idx" ON "jobs" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_leases_job_idx" ON "job_leases" USING btree ("job_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_leases_expires_idx" ON "job_leases" USING btree ("expires_at");
