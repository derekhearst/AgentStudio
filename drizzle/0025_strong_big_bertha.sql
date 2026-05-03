CREATE TYPE "public"."task_attempt_status" AS ENUM('queued', 'running', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'planning', 'awaiting_approval', 'running', 'blocked', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE "task_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid,
	"attempt_number" integer NOT NULL,
	"status" "task_attempt_status" DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"cost_usd" numeric(12, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"spec" text NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"parent_task_id" uuid,
	"owner_agent_id" uuid,
	"root_conversation_id" uuid,
	"priority" integer DEFAULT 0 NOT NULL,
	"budget_usd" numeric(12, 4),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_runs" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_runs" ADD COLUMN "task_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_root_conversation_id_conversations_id_fk" FOREIGN KEY ("root_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_attempts_task_idx" ON "task_attempts" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_attempts_run_idx" ON "task_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "task_attempts_status_idx" ON "task_attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "tasks_owner_idx" ON "tasks" USING btree ("owner_agent_id");--> statement-breakpoint
CREATE INDEX "tasks_created_by_idx" ON "tasks" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "tasks_root_conversation_idx" ON "tasks" USING btree ("root_conversation_id");--> statement-breakpoint
CREATE INDEX "chat_runs_task_idx" ON "chat_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "chat_runs_task_attempt_idx" ON "chat_runs" USING btree ("task_attempt_id");