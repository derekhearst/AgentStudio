CREATE TYPE "public"."evaluation_verdict" AS ENUM('pass', 'fail', 'needs_revision');
--> statement-breakpoint
CREATE TABLE "run_evaluations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "evaluator_run_id" uuid,
  "evaluator_agent_id" uuid,
  "verdict" "evaluation_verdict" NOT NULL,
  "findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "confidence" real,
  "cost_usd" numeric(12, 4),
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_evaluations" ADD CONSTRAINT "run_evaluations_run_id_chat_runs_id_fk"
  FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_evaluations" ADD CONSTRAINT "run_evaluations_evaluator_run_id_chat_runs_id_fk"
  FOREIGN KEY ("evaluator_run_id") REFERENCES "public"."chat_runs"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_evaluations" ADD CONSTRAINT "run_evaluations_evaluator_agent_id_agents_id_fk"
  FOREIGN KEY ("evaluator_agent_id") REFERENCES "public"."agents"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "run_evaluations_run_idx" ON "run_evaluations" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "run_evaluations_evaluator_agent_idx" ON "run_evaluations" USING btree ("evaluator_agent_id");
--> statement-breakpoint
CREATE INDEX "run_evaluations_verdict_idx" ON "run_evaluations" USING btree ("verdict");
--> statement-breakpoint
CREATE INDEX "run_evaluations_created_idx" ON "run_evaluations" USING btree ("created_at");
--> statement-breakpoint
ALTER TABLE "chat_runs" ADD COLUMN "eval_required" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_runs" ADD COLUMN "eval_attempt" integer DEFAULT 0 NOT NULL;
