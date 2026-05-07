-- Tool Search Tool migration: drop the capability-group system.
--
-- The `enable_capability` meta-tool and its capability-group taxonomy (core / sandbox /
-- skills / agents / media / research / projects / source_control) are replaced by the new
-- `search_tools` tool with the disclosure tier system in `src/lib/tools/tool-schemas.ts`.
-- That removes three columns:
--
--   1. chat_runs.enabled_capability_groups — the per-run active capability set; replaced
--      by the in-memory `loadedSearchableTools` set on the stream endpoint closure.
--   2. skills.companion_groups — auto-load-on-group-enable mapping; no longer applicable
--      since groups are gone. Skill discovery is now via listRelevantSkillSummaries
--      (relevance-ranked by user query).
--   3. skills.companion_tools — same story, the per-tool variant.
--
-- The legacy agent.config.capabilityGroups JSON field is dropped lazily by
-- updateAgentRecord and the source loader the next time an agent row is touched — no
-- separate column to migrate.

ALTER TABLE "chat_runs" DROP COLUMN IF EXISTS "enabled_capability_groups";
--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN IF EXISTS "companion_groups";
--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN IF EXISTS "companion_tools";
