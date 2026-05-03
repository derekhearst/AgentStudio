CREATE TYPE "public"."hook_kind" AS ENUM('builtin', 'skill');
--> statement-breakpoint
CREATE TABLE "hook_invocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid,
  "event" text NOT NULL,
  "hook_kind" "hook_kind" NOT NULL,
  "hook_ref" text NOT NULL,
  "success" boolean NOT NULL,
  "duration_ms" integer NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hook_invocations" ADD CONSTRAINT "hook_invocations_run_id_chat_runs_id_fk"
  FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "hook_invocations_run_idx" ON "hook_invocations" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "hook_invocations_event_idx" ON "hook_invocations" USING btree ("event");
--> statement-breakpoint
CREATE INDEX "hook_invocations_success_idx" ON "hook_invocations" USING btree ("success");
--> statement-breakpoint
CREATE INDEX "hook_invocations_created_idx" ON "hook_invocations" USING btree ("created_at");
