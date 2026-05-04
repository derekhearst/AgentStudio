-- Wave 5 #19 phase 1 — source-control durable records.
DO $$ BEGIN
  CREATE TYPE "public"."source_control_provider" AS ENUM('github', 'gitlab', 'bitbucket', 'gitea', 'local');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."source_control_connection_status" AS ENUM('active', 'error', 'revoked', 'pending');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."pull_request_status" AS ENUM('draft', 'open', 'merged', 'closed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."pull_request_check_status" AS ENUM('pending', 'running', 'success', 'failure', 'canceled', 'skipped');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repositories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "project_id" uuid,
  "provider" "source_control_provider" DEFAULT 'github' NOT NULL,
  "owner" text NOT NULL,
  "name" text NOT NULL,
  "clone_url" text NOT NULL,
  "default_branch" text DEFAULT 'main' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "repositories_user_owner_name_unique" UNIQUE("user_id", "owner", "name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repository_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "provider" "source_control_provider" NOT NULL,
  "provider_account" text NOT NULL,
  "encrypted_token" text NOT NULL,
  "scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "status" "source_control_connection_status" DEFAULT 'active' NOT NULL,
  "last_synced_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "repo_connections_user_provider_account_unique" UNIQUE("user_id", "provider", "provider_account")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repository_branches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "name" text NOT NULL,
  "task_id" uuid,
  "created_by_run_id" uuid,
  "head_sha" text,
  "is_default" boolean DEFAULT false NOT NULL,
  "state" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "repo_branches_repo_name_unique" UNIQUE("repository_id", "name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pull_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "provider_pr_number" integer NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "head_branch" text NOT NULL,
  "base_branch" text NOT NULL,
  "status" "pull_request_status" DEFAULT 'draft' NOT NULL,
  "task_id" uuid,
  "run_id" uuid,
  "created_by" uuid,
  "provider_url" text,
  "merged_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pull_requests_repo_pr_number_unique" UNIQUE("repository_id", "provider_pr_number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pull_request_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pull_request_id" uuid NOT NULL,
  "check_name" text NOT NULL,
  "status" "pull_request_check_status" DEFAULT 'pending' NOT NULL,
  "details_url" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pr_checks_pr_check_name_unique" UNIQUE("pull_request_id", "check_name")
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connections_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repository_branches" ADD CONSTRAINT "repository_branches_repository_id_repositories_id_fk"
  FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_repositories_id_fk"
  FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pull_request_checks" ADD CONSTRAINT "pull_request_checks_pull_request_id_pull_requests_id_fk"
  FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repositories_user_idx" ON "repositories" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repositories_project_idx" ON "repositories" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repositories_provider_idx" ON "repositories" USING btree ("provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_connections_user_idx" ON "repository_connections" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_connections_status_idx" ON "repository_connections" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_branches_repo_idx" ON "repository_branches" USING btree ("repository_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_branches_task_idx" ON "repository_branches" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pull_requests_repo_idx" ON "pull_requests" USING btree ("repository_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pull_requests_status_idx" ON "pull_requests" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pull_requests_task_idx" ON "pull_requests" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pull_requests_run_idx" ON "pull_requests" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_checks_pr_idx" ON "pull_request_checks" USING btree ("pull_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_checks_status_idx" ON "pull_request_checks" USING btree ("status");
