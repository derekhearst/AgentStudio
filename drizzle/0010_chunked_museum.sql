CREATE TABLE IF NOT EXISTS "memory_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536),
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_chunks_memory_id_idx" ON "memory_chunks" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_chunks_embedding_hnsw_idx" ON "memory_chunks" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_chunks_position_idx" ON "memory_chunks" USING btree ("memory_id", "position");