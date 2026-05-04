-- Wave 4 #18 phase 1 — research domain schema.
DO $$ BEGIN
  CREATE TYPE "public"."research_status" AS ENUM('planning', 'searching', 'fetching', 'synthesizing', 'complete', 'failed', 'canceled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."research_step_kind" AS ENUM('plan', 'search', 'fetch', 'extract', 'synthesize', 'note');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "conversation_id" uuid,
  "run_id" uuid,
  "job_id" uuid,
  "query" text NOT NULL,
  "status" "research_status" DEFAULT 'planning' NOT NULL,
  "plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "report" text,
  "cost_usd" numeric(12, 4) DEFAULT '0' NOT NULL,
  "tokens_used" integer DEFAULT 0 NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "research_id" uuid NOT NULL,
  "url" text NOT NULL,
  "title" text,
  "extracted_text" text,
  "content_type" text DEFAULT 'html' NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cited_in_report" boolean DEFAULT false NOT NULL,
  "notes" text,
  "cost_usd" numeric(12, 4)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "research_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "kind" "research_step_kind" NOT NULL,
  "sub_question" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "cost_usd" numeric(12, 4),
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "error" text
);
--> statement-breakpoint
ALTER TABLE "research" ADD CONSTRAINT "research_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_research_id_research_id_fk"
  FOREIGN KEY ("research_id") REFERENCES "public"."research"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "research_steps" ADD CONSTRAINT "research_steps_research_id_research_id_fk"
  FOREIGN KEY ("research_id") REFERENCES "public"."research"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_user_idx" ON "research" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_status_idx" ON "research" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_conversation_idx" ON "research" USING btree ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_job_idx" ON "research" USING btree ("job_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_created_idx" ON "research" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_sources_research_idx" ON "research_sources" USING btree ("research_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_sources_cited_idx" ON "research_sources" USING btree ("cited_in_report");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_steps_research_idx" ON "research_steps" USING btree ("research_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_steps_seq_idx" ON "research_steps" USING btree ("research_id", "seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_steps_kind_idx" ON "research_steps" USING btree ("kind");
