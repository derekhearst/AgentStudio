CREATE TYPE "public"."budget_action" AS ENUM('block', 'notify_only');--> statement-breakpoint
CREATE TYPE "public"."budget_period" AS ENUM('day', 'week', 'month', 'run');--> statement-breakpoint
CREATE TYPE "public"."budget_scope" AS ENUM('global', 'project', 'agent', 'run');--> statement-breakpoint
CREATE TYPE "public"."budget_trigger_type" AS ENUM('warn', 'block');--> statement-breakpoint
CREATE TABLE "budget_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budget_limit_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"trigger_type" "budget_trigger_type" NOT NULL,
	"spend_at_trigger" numeric(18, 6) NOT NULL,
	"limit_usd" numeric(18, 6) NOT NULL,
	"period" "budget_period" NOT NULL,
	"run_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" "budget_scope" NOT NULL,
	"scope_id" uuid,
	"period" "budget_period" NOT NULL,
	"limit_usd" numeric(18, 6) NOT NULL,
	"warn_usd" numeric(18, 6),
	"action" "budget_action" DEFAULT 'block' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_budget_limit_id_budget_limits_id_fk" FOREIGN KEY ("budget_limit_id") REFERENCES "public"."budget_limits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_limits" ADD CONSTRAINT "budget_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_alerts_user_idx" ON "budget_alerts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "budget_alerts_limit_idx" ON "budget_alerts" USING btree ("budget_limit_id");--> statement-breakpoint
CREATE INDEX "budget_alerts_created_idx" ON "budget_alerts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "budget_limits_user_idx" ON "budget_limits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "budget_limits_scope_idx" ON "budget_limits" USING btree ("scope","scope_id");