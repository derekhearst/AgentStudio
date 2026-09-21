-- Drop the artifacts domain.
--
-- Artifacts promoted in-chat documents to versioned DB rows (`artifacts` +
-- `artifact_versions`), with their own feed, drawer, detail route and five agent tools.
-- The agent writes real files into its sandbox workspace now, and git is the version
-- history, so the whole layer is redundant. Both prod and dev held 0 artifacts and 0
-- artifact_versions at the time of this migration, so there is nothing to migrate out.
--
-- Also removes the two cross-domain pointers into the dropped tables:
--   - memory_drawers.linked_artifact_id (the Memory ↔ Projects bridge)
--   - review_items.artifact_id (only ever set by the never-emitted artifact_conflict type)
--
-- Deliberately NOT touched: the `review_item_type` and `automation_output_target` PG enums
-- keep their now-unused 'artifact_conflict' / 'artifact' values. Dropping an enum value
-- means recreating the type and rewriting every dependent column for no functional gain;
-- the application-side enums no longer list them, so nothing can write one.

-- ─────────── Cross-domain pointers ───────────

DROP INDEX IF EXISTS memory_drawers_linked_artifact_idx;
ALTER TABLE memory_drawers DROP COLUMN IF EXISTS linked_artifact_id;

ALTER TABLE review_items DROP COLUMN IF EXISTS artifact_id;

-- ─────────── Tables ───────────
-- artifact_versions first: it carries the FK back to artifacts.

DROP TABLE IF EXISTS artifact_versions;
DROP TABLE IF EXISTS artifacts;

-- ─────────── Types ───────────
-- artifact_content_type only ever backed artifacts.content_type.

DROP TYPE IF EXISTS artifact_content_type;
