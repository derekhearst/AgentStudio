-- App-wide log table.
--
-- The observability logger writes structured log lines here so an operator (especially on
-- mobile, away from a terminal) can browse warn/error events without stdout access. Writes
-- are batched + best-effort: a failed insert falls back to console and never blocks the
-- call site. Rows are pruned by a daily retention job; default 14-day window.
--
-- user_id is set when the call site has a request user in scope; ON DELETE SET NULL so
-- historical logs survive a user soft-delete.

DO $$ BEGIN
  CREATE TYPE "public"."log_level" AS ENUM ('debug', 'info', 'warn', 'error');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ts" timestamp with time zone DEFAULT now() NOT NULL,
  "level" "log_level" NOT NULL,
  "message" text NOT NULL,
  "context" jsonb,
  "source" text,
  "user_id" uuid
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "app_logs" ADD CONSTRAINT "app_logs_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_logs_ts_idx" ON "app_logs" USING btree ("ts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_logs_level_ts_idx" ON "app_logs" USING btree ("level", "ts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_logs_source_ts_idx" ON "app_logs" USING btree ("source", "ts");
