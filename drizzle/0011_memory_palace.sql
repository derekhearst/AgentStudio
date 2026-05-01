CREATE TYPE "public"."memory_drawer_role" AS ENUM('user', 'assistant', 'system', 'note');--> statement-breakpoint
CREATE TYPE "public"."memory_wing_kind" AS ENUM('person', 'project', 'topic', 'agent');--> statement-breakpoint
CREATE TABLE "memory_closets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_closets_room_topic_unique" UNIQUE("room_id","topic")
);
--> statement-breakpoint
CREATE TABLE "memory_drawers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"closet_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "memory_drawer_role" DEFAULT 'note' NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536),
	"aaak" jsonb,
	"token_count" integer DEFAULT 0 NOT NULL,
	"source_message_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_kg_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'thing' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_kg_entities_user_name_type_unique" UNIQUE("user_id","name","type")
);
--> statement-breakpoint
CREATE TABLE "memory_kg_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"from_entity_id" uuid NOT NULL,
	"to_entity_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"confidence" real DEFAULT 1 NOT NULL,
	"source_drawer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "artifacts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memories" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_relations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "artifact_versions" CASCADE;--> statement-breakpoint
DROP TABLE "artifacts" CASCADE;--> statement-breakpoint
DROP TABLE "memories" CASCADE;--> statement-breakpoint
DROP TABLE "memory_relations" CASCADE;--> statement-breakpoint
ALTER TABLE "memory_rooms" DROP CONSTRAINT "memory_rooms_closet_for_room_id_memory_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "activity_events" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."activity_event_type";--> statement-breakpoint
CREATE TYPE "public"."activity_event_type" AS ENUM('task_created', 'task_status_changed', 'agent_action', 'chat_started', 'review_action', 'skill_created', 'project_created', 'project_status_changed', 'goal_created', 'strategy_submitted', 'strategy_approved', 'strategy_rejected');--> statement-breakpoint
ALTER TABLE "activity_events" ALTER COLUMN "type" SET DATA TYPE "public"."activity_event_type" USING "type"::"public"."activity_event_type";--> statement-breakpoint
ALTER TABLE "memory_wings" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "tool_config" SET DEFAULT '{"approvalRequiredTools":[]}'::jsonb;--> statement-breakpoint
ALTER TABLE "memory_rooms" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_rooms" ADD COLUMN "label" text NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_rooms" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "memory_rooms" ADD COLUMN "occurred_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_wings" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_wings" ADD COLUMN "kind" "memory_wing_kind" DEFAULT 'topic' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_wings" ADD COLUMN "slug" text NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_wings" ADD COLUMN "aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_wings" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "memory_closets" ADD CONSTRAINT "memory_closets_room_id_memory_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."memory_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_drawers" ADD CONSTRAINT "memory_drawers_closet_id_memory_closets_id_fk" FOREIGN KEY ("closet_id") REFERENCES "public"."memory_closets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_drawers" ADD CONSTRAINT "memory_drawers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_drawers" ADD CONSTRAINT "memory_drawers_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_kg_entities" ADD CONSTRAINT "memory_kg_entities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_kg_relations" ADD CONSTRAINT "memory_kg_relations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_kg_relations" ADD CONSTRAINT "memory_kg_relations_from_entity_id_memory_kg_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."memory_kg_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_kg_relations" ADD CONSTRAINT "memory_kg_relations_to_entity_id_memory_kg_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."memory_kg_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_kg_relations" ADD CONSTRAINT "memory_kg_relations_source_drawer_id_memory_drawers_id_fk" FOREIGN KEY ("source_drawer_id") REFERENCES "public"."memory_drawers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_closets_room_idx" ON "memory_closets" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "memory_drawers_closet_idx" ON "memory_drawers" USING btree ("closet_id");--> statement-breakpoint
CREATE INDEX "memory_drawers_user_occurred_idx" ON "memory_drawers" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "memory_drawers_embedding_hnsw_idx" ON "memory_drawers" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memory_drawers_content_tsv_idx" ON "memory_drawers" USING gin (to_tsvector('english', "content"));--> statement-breakpoint
CREATE INDEX "memory_kg_entities_user_idx" ON "memory_kg_entities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memory_kg_relations_user_idx" ON "memory_kg_relations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memory_kg_relations_from_idx" ON "memory_kg_relations" USING btree ("from_entity_id","valid_from");--> statement-breakpoint
CREATE INDEX "memory_kg_relations_to_idx" ON "memory_kg_relations" USING btree ("to_entity_id","valid_from");--> statement-breakpoint
ALTER TABLE "memory_rooms" ADD CONSTRAINT "memory_rooms_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_wings" ADD CONSTRAINT "memory_wings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_rooms_wing_idx" ON "memory_rooms" USING btree ("wing_id");--> statement-breakpoint
CREATE INDEX "memory_rooms_occurred_idx" ON "memory_rooms" USING btree ("wing_id","occurred_at");--> statement-breakpoint
CREATE INDEX "memory_wings_user_idx" ON "memory_wings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memory_wings_aliases_gin" ON "memory_wings" USING gin ("aliases");--> statement-breakpoint
ALTER TABLE "memory_rooms" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "memory_rooms" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "memory_rooms" DROP COLUMN "is_closet";--> statement-breakpoint
ALTER TABLE "memory_rooms" DROP COLUMN "closet_for_room_id";--> statement-breakpoint
ALTER TABLE "memory_rooms" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "memory_wings" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "memory_wings" ADD CONSTRAINT "memory_wings_user_slug_unique" UNIQUE("user_id","slug");--> statement-breakpoint
DROP TYPE "public"."artifact_type";--> statement-breakpoint
DROP TYPE "public"."memory_relation_type";--> statement-breakpoint
DROP TYPE "public"."hall_type";