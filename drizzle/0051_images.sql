-- Generated-image audit table.
--
-- Every successful image_generate tool call inserts one row here so the /artifacts
-- feed can surface past images alongside research reports and project artifacts.
-- conversation_id and run_id are by-name pointers (no FK) to avoid circular
-- dependencies on $lib/sessions and $lib/runs — same convention as research.

CREATE TABLE IF NOT EXISTS "images" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "conversation_id" uuid,
  "run_id" uuid,
  "prompt" text NOT NULL,
  "model" text NOT NULL,
  "size" text,
  "url" text NOT NULL,
  "cost_usd" numeric(12, 4),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "images" ADD CONSTRAINT "images_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "images_user_idx" ON "images" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "images_conversation_idx" ON "images" USING btree ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "images_created_idx" ON "images" USING btree ("created_at");
