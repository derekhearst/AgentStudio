-- Wave 4 #15 phase 2 — bind a conversation to a project so agent edits know where to put
-- new artifacts. Declared by-name (no enforced FK) to avoid a circular import with the
-- projects schema; application logic enforces ownership at the tool boundary.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "project_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_project_idx" ON "conversations" USING btree ("project_id");
