-- Deep Research rebuild — schema bits.
--
-- 1. Adds 'reflecting' to research_status enum (new orchestrator phase between fetch and
--    synthesize that identifies coverage gaps and runs a second search pass).
-- 2. Adds nullable `model` column on research so the composer-selected model can drive the
--    per-run planner/reflection/synthesizer phases (overrides DEFAULT_RESEARCH_CONFIG).
--
-- The mode-skill prompt refresh is in 0049 as a separate concern.

ALTER TYPE "public"."research_status" ADD VALUE IF NOT EXISTS 'reflecting' BEFORE 'synthesizing';
--> statement-breakpoint
ALTER TABLE "research" ADD COLUMN IF NOT EXISTS "model" text;
