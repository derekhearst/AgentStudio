ALTER TABLE "project_goals" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_strategies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "project_goals" CASCADE;--> statement-breakpoint
DROP TABLE "project_strategies" CASCADE;--> statement-breakpoint
DROP TABLE "projects" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_tasks" DROP CONSTRAINT "agent_tasks_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_task_id_agent_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "agent_tasks" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "artifacts" DROP COLUMN "task_id";--> statement-breakpoint
DROP TYPE "public"."project_goal_status";--> statement-breakpoint
DROP TYPE "public"."project_status";--> statement-breakpoint
DROP TYPE "public"."strategy_status";