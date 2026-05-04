-- Wave 4 #15 phase 1 — projects + artifacts + artifact_versions.
-- Hand-written for parity with the rest of the Wave 3+ chain (drizzle-kit can't
-- emit clean cross-FK ordering when artifacts.current_version_id points at
-- artifact_versions.id while artifact_versions.artifact_id points back).
DO $$ BEGIN
  CREATE TYPE "public"."project_kind" AS ENUM('efoil', 'research', 'code', 'documentation', 'other');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."artifact_content_type" AS ENUM('markdown', 'code', 'json', 'yaml', 'plaintext');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "kind" "project_kind" DEFAULT 'other' NOT NULL,
  "user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "projects_user_slug_unique" UNIQUE("user_id", "slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "content_type" "artifact_content_type" DEFAULT 'markdown' NOT NULL,
  "current_version_id" uuid,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "artifacts_project_slug_unique" UNIQUE("project_id", "slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifact_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "artifact_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "content" text NOT NULL,
  "change_note" text,
  "edited_by" uuid,
  "source_run_id" uuid,
  "cost_usd" numeric(12, 4),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "artifact_versions_artifact_seq_unique" UNIQUE("artifact_id", "seq")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk"
  FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_edited_by_users_id_fk"
  FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_user_idx" ON "projects" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_kind_idx" ON "projects" USING btree ("kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_project_idx" ON "artifacts" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_active_idx" ON "artifacts" USING btree ("is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_versions_artifact_idx" ON "artifact_versions" USING btree ("artifact_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_versions_created_idx" ON "artifact_versions" USING btree ("created_at");
