-- Wave 5 #22 phase 2 — agents.identity_skill_id column for prompt-as-data per-agent.
-- Declared by-name (no enforced FK to skills) so deleting a skill leaves the agent's
-- pointer stale; buildAgentDefinition falls back to systemPrompt when the skill is
-- missing/disabled. Same defense-in-depth pattern as the orchestrator identity.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "identity_skill_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_identity_skill_idx" ON "agents" USING btree ("identity_skill_id");
