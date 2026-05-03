CREATE TABLE "tool_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"run_id" uuid,
	"task_id" uuid,
	"agent_id" uuid,
	"tool_name" text NOT NULL,
	"provider" text,
	"unit_type" text NOT NULL,
	"units" numeric(18, 6) DEFAULT '0' NOT NULL,
	"cost" numeric(18, 12) DEFAULT '0' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_usage" ADD CONSTRAINT "tool_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_usage" ADD CONSTRAINT "tool_usage_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_usage" ADD CONSTRAINT "tool_usage_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_usage_user_idx" ON "tool_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tool_usage_run_idx" ON "tool_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "tool_usage_task_idx" ON "tool_usage" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tool_usage_agent_idx" ON "tool_usage" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "tool_usage_tool_idx" ON "tool_usage" USING btree ("tool_name");--> statement-breakpoint
CREATE INDEX "tool_usage_created_idx" ON "tool_usage" USING btree ("created_at");