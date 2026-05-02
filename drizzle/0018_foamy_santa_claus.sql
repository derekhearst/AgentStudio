CREATE TYPE "public"."chat_mode" AS ENUM('chat', 'research', 'plan', 'agent');--> statement-breakpoint
CREATE TABLE "chat_workbench_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"default_mode" "chat_mode" DEFAULT 'chat' NOT NULL,
	"show_right_panel" boolean DEFAULT true NOT NULL,
	"panel_layout" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_workbench_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "mode" "chat_mode" DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_workbench_preferences" ADD CONSTRAINT "chat_workbench_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;