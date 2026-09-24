CREATE TYPE "public"."mcp_transport" AS ENUM('http', 'sse');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'mcp_server.created';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'mcp_server.updated';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'mcp_server.deleted';--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"transport" "mcp_transport" NOT NULL,
	"url" text NOT NULL,
	"header_names" text[] DEFAULT '{}' NOT NULL,
	"has_bearer_token" boolean DEFAULT false NOT NULL,
	"encrypted_secrets" text,
	"tool_policies" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tools_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"timeout_ms" integer,
	"last_tested_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_user_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_servers_user_idx" ON "mcp_servers" USING btree ("user_id");