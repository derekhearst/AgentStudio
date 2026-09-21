CREATE TYPE "public"."memory_exclusion_kind" AS ENUM('regex', 'substring');--> statement-breakpoint
CREATE TYPE "public"."memory_recall_source" AS ENUM('chat', 'agent', 'search', 'bench');--> statement-breakpoint
CREATE TABLE "memory_exclusion_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "memory_exclusion_kind" DEFAULT 'regex' NOT NULL,
	"pattern" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_exclusion_rules_user_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "memory_recall_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"drawer_id" uuid NOT NULL,
	"query" text NOT NULL,
	"source" "memory_recall_source" DEFAULT 'chat' NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"semantic_score" real DEFAULT 0 NOT NULL,
	"keyword_score" real DEFAULT 0 NOT NULL,
	"temporal_score" real DEFAULT 0 NOT NULL,
	"pinned_boost" real DEFAULT 0 NOT NULL,
	"final_score" real DEFAULT 0 NOT NULL,
	"weights" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_drawers" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_drawers" ADD COLUMN "never_recall" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_drawers" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_exclusion_rules" ADD CONSTRAINT "memory_exclusion_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_recall_events" ADD CONSTRAINT "memory_recall_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_recall_events" ADD CONSTRAINT "memory_recall_events_drawer_id_memory_drawers_id_fk" FOREIGN KEY ("drawer_id") REFERENCES "public"."memory_drawers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_exclusion_rules_user_idx" ON "memory_exclusion_rules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memory_recall_events_drawer_idx" ON "memory_recall_events" USING btree ("drawer_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_recall_events_user_idx" ON "memory_recall_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_drawers_user_pinned_idx" ON "memory_drawers" USING btree ("user_id","pinned");