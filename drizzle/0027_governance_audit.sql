CREATE TYPE "public"."audit_action" AS ENUM(
  'settings.updated',
  'settings.reset',
  'agent.config.updated',
  'agent.created',
  'agent.deleted',
  'agent.status.changed',
  'budget_limit.created',
  'budget_limit.updated',
  'budget_limit.deleted',
  'skill.deleted',
  'user.created',
  'user.deactivated',
  'user.role.changed'
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_user_id" uuid,
  "action" "audit_action" NOT NULL,
  "target_type" text,
  "target_id" text,
  "before_state" jsonb,
  "after_state" jsonb,
  "summary" text,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");
--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action");
--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");
--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");
