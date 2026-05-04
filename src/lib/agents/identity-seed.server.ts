import { skills } from '$lib/skills/skills.schema'
import { db } from '$lib/db.server'

type DbLike = typeof db

/**
 * Wave 5 #22 phase 1 — orchestrator identity as an editable skill.
 *
 * Promotes the hardcoded `ORCHESTRATOR_IDENTITY` TS constant in `agents/orchestrator.ts` into
 * a boot-seeded skill named `system/orchestrator-identity` with a fixed UUID. Operators can
 * edit the skill content via the existing `/skills/[id]` route + the next chat run picks up
 * the change without a deploy. The TS constant remains as a fallback when the skill is missing
 * or disabled (defense in depth — a misconfigured skill row can never break orchestrator chat).
 *
 * Idempotency: ON CONFLICT (id) DO NOTHING + ON CONFLICT (name) DO NOTHING so user edits
 * survive across boots. To force a content refresh, bump the UUID (same pattern as the mode-
 * identity + companion skill seeds).
 */

export const ORCHESTRATOR_IDENTITY_SKILL_ID = '00000000-0000-4000-8000-00000000a001'
export const ORCHESTRATOR_IDENTITY_SKILL_NAME = 'system/orchestrator-identity'

/**
 * The default orchestrator identity content. Mirrors the TS constant in
 * `agents/orchestrator.ts` so the seed creates a known-good baseline; operators can edit
 * after the seed lands without re-running it.
 */
export const ORCHESTRATOR_IDENTITY_DEFAULT = `You are the Orchestrator — the user's primary AI assistant in AgentStudio.

Your responsibilities:
- Answer questions directly when you can (simple path)
- For complex, multi-step work, propose a plan with specific agents before executing
- Delegate sub-tasks to specialized agents when their expertise is needed
- Synthesize sub-agent results into coherent responses

Behavior:
- Be concise and helpful. Don't over-explain.
- When a task is simple (lookup, chat, brainstorming), handle it yourself — no plan needed.
- When a task is complex (multi-step, needs tools, specialized knowledge), propose a plan first.
- Plans list the steps and which agent handles each. Wait for user approval before executing.
- After sub-agents complete, synthesize their results and present a unified response.
`

export async function seedOrchestratorIdentity(dbInstance: DbLike): Promise<{ inserted: number }> {
	const now = new Date()
	const result = await dbInstance
		.insert(skills)
		.values({
			id: ORCHESTRATOR_IDENTITY_SKILL_ID,
			name: ORCHESTRATOR_IDENTITY_SKILL_NAME,
			description: 'The system prompt that runs on conversations without a specific agent (orchestrator path).',
			content: ORCHESTRATOR_IDENTITY_DEFAULT,
			tags: ['system', 'identity'],
			enabled: true,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing()
		.returning({ id: skills.id })
	return { inserted: result.length }
}
