ALTER TABLE "llm_usage" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_usage_user_idx" ON "llm_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "llm_usage_run_idx" ON "llm_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "llm_usage_task_idx" ON "llm_usage" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "llm_usage_agent_idx" ON "llm_usage" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "llm_usage_created_idx" ON "llm_usage" USING btree ("created_at");