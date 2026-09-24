CREATE TABLE "message_search" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"body" text NOT NULL,
	"builder_version" integer NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "message_search"."body")) STORED,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_search" ADD CONSTRAINT "message_search_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_search" ADD CONSTRAINT "message_search_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_search_tsv_idx" ON "message_search" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "message_search_conversation_idx" ON "message_search" USING btree ("conversation_id");