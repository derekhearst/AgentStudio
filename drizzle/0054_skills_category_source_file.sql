-- PR-3: skills.category and skills.source_file additions.
--
-- The skills domain was missing two fields the spec calls for:
--   - `category`: lets the runtime always-include filter use a clean predicate
--     (`category IN ('identity','hook')`) instead of a name-prefix LIKE pattern.
--   - `source_file`: tags rows that originated from a `SKILL.md` on disk so the repo file
--     boot loader (PR-4) can detect "row exists but came from disk vs. came from the UI".
--
-- Both columns are nullable text — NOT a Postgres enum — so we can iterate the category set
-- via Zod without painful enum migrations. Backfill derives category from the existing
-- `name` namespace, which is the same convention seeded data already uses
-- (`system/mode-*`, `tools/*`, etc.).

ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "category" text;
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "source_file" text;
--> statement-breakpoint

UPDATE "skills" SET "category" = CASE
  WHEN "name" LIKE 'system/%'   THEN 'identity'
  WHEN "name" LIKE 'tools/%'    THEN 'tool'
  WHEN "name" LIKE 'workflow/%' THEN 'workflow'
  WHEN "name" LIKE 'domain/%'   THEN 'domain'
  WHEN "name" LIKE 'policy/%'   THEN 'policy'
  WHEN "name" LIKE 'hook/%'     THEN 'hook'
  ELSE 'domain'
END WHERE "category" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "skills_category_idx" ON "skills" ("category");
