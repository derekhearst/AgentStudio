CREATE INDEX IF NOT EXISTS "memories_embedding_hnsw_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_room_updated_idx" ON "memories" USING btree ("room_id", "updated_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_wing_updated_idx" ON "memories" USING btree ("wing_id", "updated_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_importance_updated_idx" ON "memories" USING btree ("importance" DESC, "updated_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_relations_source_idx" ON "memory_relations" USING btree ("source_memory_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_relations_target_idx" ON "memory_relations" USING btree ("target_memory_id");