-- Hand-written follow-up to 0025 — cross-domain foreign keys that drizzle-kit didn't emit
-- because the source schemas declare the columns as bare uuid (without `references()`) to
-- dodge circular imports between runs/tasks and tasks/tasks. Add them here so the relational
-- guarantees actually exist in the DB.

-- Self-FK on tasks.parent_task_id. CASCADE so deleting a parent task trims the whole subtree.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk"
  FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- chat_runs → tasks. SET NULL on delete so deleting a task doesn't nuke the historical chat
-- runs that materialized it (forensic visibility wins over orphan cleanup here).
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_task_id_tasks_id_fk"
  FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- chat_runs → task_attempts. Same SET NULL rationale.
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_task_attempt_id_task_attempts_id_fk"
  FOREIGN KEY ("task_attempt_id") REFERENCES "public"."task_attempts"("id")
  ON DELETE set null ON UPDATE no action;
