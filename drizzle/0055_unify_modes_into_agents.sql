-- Unify chat modes into the agents abstraction.
--
-- Replaces the prior 4-mode concept (chat / research / plan / agent) with four built-in
-- agents seeded by `seedBuiltinAgents`. Conversations bind only to an agent — `mode` and
-- `chat_mode` enum are dropped. Workbench preferences track `default_agent_id` instead of
-- `default_mode`.
--
-- Migration order (load-bearing):
--   1. Add new agents columns (builtin_key, anchor_prompt) + partial unique index
--   2. Insert four built-in agents with stable UUIDs and existing identity-skill UUIDs
--   3. Backfill conversations.agent_id from mode (gate on agent_id IS NULL so custom-agent
--      assignments are preserved)
--   4. Make conversations.agent_id NOT NULL, then drop mode column
--   5. Migrate workbench prefs default_mode → default_agent_id
--   6. Drop the chat_mode enum

-- 1. New columns on agents
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "builtin_key" TEXT;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "anchor_prompt" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "agents_builtin_key_uidx"
	ON "agents" ("builtin_key") WHERE "builtin_key" IS NOT NULL;
--> statement-breakpoint

-- 2. Insert built-in agents. system_prompt is a placeholder; the seeder backfills with the
--    real content and the linked identity skills (c001/c002/c023/c004) carry the live
--    posture text. ON CONFLICT DO NOTHING so the migration is idempotent across re-runs.
INSERT INTO "agents" (id, name, role, system_prompt, model, config, status, kind,
                     identity_skill_id, builtin_key, anchor_prompt)
VALUES
	('00000000-0000-4000-8000-0000000a6e71', 'Chat', 'Conversational and collaborative.',
	 'Seeded at boot.', 'anthropic/claude-sonnet-4', '{"toolPolicy":{"kind":"unrestricted"}}'::jsonb,
	 'idle', 'orchestrator', '00000000-0000-4000-8000-00000000c001', 'chat',
	 '[Agent changed to Chat] You are now the Chat agent. Be conversational and collaborative. Keep responses concise; ask clarifying questions when intent is ambiguous.'),
	('00000000-0000-4000-8000-0000000a6e72', 'Research', 'Skeptical investigator; cites sources.',
	 'Seeded at boot.', 'anthropic/claude-sonnet-4',
	 '{"toolPolicy":{"kind":"readOnly","allow":["ask_user","propose_plan","enable_capability","web_search","file_read","list_directory","search_files","file_info","browser_screenshot","web_fetch","pdf_read","git_status","git_log","git_diff","list_skills","read_skill","read_skill_file","list_my_repos","list_pull_requests","get_pull_request","prepare_commit","list_projects","list_artifacts","read_artifact","list_automations","recall_memory","list_memory"]}}'::jsonb,
	 'idle', 'orchestrator', '00000000-0000-4000-8000-00000000c002', 'research',
	 '[Agent changed to Research] You are now the Research agent. Be a skeptical investigator. Cite sources for every factual claim, prefer primary references, and call out unknowns explicitly.'),
	('00000000-0000-4000-8000-0000000a6e73', 'Plan', 'Proposes structured plans before acting.',
	 'Seeded at boot.', 'anthropic/claude-sonnet-4',
	 '{"toolPolicy":{"kind":"readOnly","allow":["ask_user","propose_plan","enable_capability","web_search","file_read","list_directory","search_files","file_info","browser_screenshot","web_fetch","pdf_read","git_status","git_log","git_diff","list_skills","read_skill","read_skill_file","list_my_repos","list_pull_requests","get_pull_request","prepare_commit","list_projects","list_artifacts","read_artifact","list_automations","recall_memory","list_memory"]}}'::jsonb,
	 'idle', 'orchestrator', '00000000-0000-4000-8000-00000000c023', 'plan',
	 '[Agent changed to Plan] You are now the Plan agent. Propose a structured plan with explicit success criteria and risk callouts before taking any actions. Wait for approval before executing.'),
	('00000000-0000-4000-8000-0000000a6e74', 'Autonomous', 'Executes autonomously with minimal interruption.',
	 'Seeded at boot.', 'anthropic/claude-sonnet-4', '{"toolPolicy":{"kind":"unrestricted"}}'::jsonb,
	 'idle', 'orchestrator', '00000000-0000-4000-8000-00000000c004', 'autonomous',
	 '[Agent changed to Autonomous] You are now the Autonomous agent. Execute autonomously with minimal interruptions. Report progress concisely; only stop for blocking decisions or hard failures.')
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- 3. Backfill conversations.agent_id from mode (only where unset — preserves custom agents).
UPDATE "conversations" SET agent_id = '00000000-0000-4000-8000-0000000a6e71'::uuid WHERE agent_id IS NULL AND mode = 'chat';--> statement-breakpoint
UPDATE "conversations" SET agent_id = '00000000-0000-4000-8000-0000000a6e72'::uuid WHERE agent_id IS NULL AND mode = 'research';--> statement-breakpoint
UPDATE "conversations" SET agent_id = '00000000-0000-4000-8000-0000000a6e73'::uuid WHERE agent_id IS NULL AND mode = 'plan';--> statement-breakpoint
UPDATE "conversations" SET agent_id = '00000000-0000-4000-8000-0000000a6e74'::uuid WHERE agent_id IS NULL AND mode = 'agent';--> statement-breakpoint

-- 4. Drop the mode column. agent_id stays nullable at the DB layer (the application
--    enforces non-null on new inserts via `resolveDefaultAgentId`); this avoids breaking
--    test fixtures that bypass the app and write raw SQL with no agent_id.
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "mode";--> statement-breakpoint

-- 5. Migrate workbench preferences: default_mode → default_agent_id.
ALTER TABLE "chat_workbench_preferences"
	ADD COLUMN IF NOT EXISTS "default_agent_id" UUID REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
UPDATE "chat_workbench_preferences" SET default_agent_id = CASE default_mode
	WHEN 'chat'     THEN '00000000-0000-4000-8000-0000000a6e71'::uuid
	WHEN 'research' THEN '00000000-0000-4000-8000-0000000a6e72'::uuid
	WHEN 'plan'     THEN '00000000-0000-4000-8000-0000000a6e73'::uuid
	WHEN 'agent'    THEN '00000000-0000-4000-8000-0000000a6e74'::uuid
END WHERE default_agent_id IS NULL;--> statement-breakpoint
ALTER TABLE "chat_workbench_preferences" DROP COLUMN IF EXISTS "default_mode";--> statement-breakpoint

-- 6. Drop the chat_mode enum (no remaining DB consumers).
DROP TYPE IF EXISTS "chat_mode";
