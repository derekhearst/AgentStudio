-- Wave 4 #15 phase 3 — Memory ↔ Projects bridge.
-- Add a nullable linked_artifact_id column to memory_drawers so a drawer can be tagged with
-- the specific artifact it references. Declared by-name (no enforced FK) to avoid circular
-- import with the projects schema; application logic treats stale pointers as null.
ALTER TABLE "memory_drawers" ADD COLUMN IF NOT EXISTS "linked_artifact_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_drawers_linked_artifact_idx" ON "memory_drawers" USING btree ("linked_artifact_id");
