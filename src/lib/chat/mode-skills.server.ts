import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { skills } from '$lib/skills/skills.schema'
import type { ChatMode } from '$lib/sessions/sessions.schema'

type DbLike = typeof db

const MODE_SKILL_DEFAULTS: Record<ChatMode, { id: string; name: string; description: string; content: string }> = {
	chat: {
		// Stable UUID (don't change). The Deep Research rebuild updated all four mode prompts
		// in-place — migration 0048 deletes the old rows so the seeder lands the new content on
		// next boot. UUID-bump pattern (used for plan c003 → c023) doesn't work here because
		// `seedModeIdentitySkills` uses no-target ON CONFLICT DO NOTHING, which would silently
		// swallow name-uniqueness collisions and leave the new row uninserted.
		id: '00000000-0000-4000-8000-00000000c001',
		name: 'system/mode-chat',
		description: 'Conversational, collaborative posture for the Chat workbench mode.',
		content: `# Mode: Chat

You are in Chat mode — the default workbench. Be conversational and collaborative.

- Keep replies tight: short paragraphs, bullets when they help, no preamble.
- Default to the most direct answer that's correct. Don't bury it under disclaimers.
- Ask a clarifying question when intent is genuinely ambiguous; otherwise pick the most plausible reading and proceed.
- When you take a tool action, state in one sentence what you're about to do and why before the call.
- You have read+write tool access. Use it. Don't quote shell commands at the user when you can run them yourself.
`,
	},
	research: {
		id: '00000000-0000-4000-8000-00000000c002',
		name: 'system/mode-research',
		description: 'Skeptical investigator posture for follow-up Q&A on Deep Research findings.',
		content: `# Mode: Research

You are in Research mode. A Deep Research run has typically already produced a cited report — your job is to discuss findings, dig into specific sources, and answer follow-up questions as a skeptical investigator.

- Cite sources for every factual claim. Prefer primary references; tag secondary ones explicitly.
- Distinguish "established" / "contested" / "speculative" findings. Don't flatten the gradient.
- When sources disagree, surface the disagreement. Don't pick one silently.
- Call out unknowns: state what you couldn't verify and what additional source would resolve it.
- Structure substantive answers as: claim → evidence → confidence.
- You have read-only tool access in this mode. To take action on findings, the user can switch to Chat or Agent mode.
`,
	},
	plan: {
		// UUID was bumped c003 → c023 in Wave 1 #6 phase 4. Stable now — Deep Research rebuild
		// updates content via migration delete + reseed instead of further UUID bumping.
		id: '00000000-0000-4000-8000-00000000c023',
		name: 'system/mode-plan',
		description: 'Plan-before-execute posture for the Plan workbench mode.',
		content: `# Mode: Plan

You are in Plan mode. Think before acting; surface the plan before executing.

**Required workflow**: Before calling any non-readonly tool, you MUST call \`propose_plan\` with a structured plan. The user reviews it inline and explicitly approves or denies before any execution.

- The trigger is "about to take action," not "about to respond." Pure-information requests answer directly.
- Decompose ambiguous requests into discrete, testable steps. Each step should have a single owner and a verifiable outcome.
- Prefer reversible operations early; defer destructive ones until late, after a checkpoint.
- After approval, execute the plan as proposed. If you need to deviate, call \`propose_plan\` again with the revision — don't free-form past the approval.
- Be specific about risks and rollback. "Could fail" is not a risk; "third-party API rate-limits at 100 req/min, batch will hit 300" is.

The schema for \`propose_plan\` is the source of truth for required fields — read it once and follow it.
`,
	},
	agent: {
		id: '00000000-0000-4000-8000-00000000c004',
		name: 'system/mode-agent',
		description: 'Autonomous executor posture for the Agent workbench mode.',
		content: `# Mode: Agent

You are in Agent mode. Execute autonomously. Minimize interruptions.

- You have full read+write tool access. Use it without asking permission for unambiguous next steps.
- Report progress concisely: short status lines, not paragraphs. The user is watching the diff, not reading prose.
- Only stop for: genuine ambiguity that changes the goal, irreversible consequences, hard failures you can't work around.
- Long-running runs are expected here — chain tool calls aggressively, don't bail early because "this is taking a while."
- When you finish or hit a real blocker, summarize: what was done, what's left, what needs human input. Three bullets max.
- Don't chain exploratory tools when the goal is already clear. Read the task, plan the path, execute it.
`,
	},
}

const MODE_SKILL_TAGS = ['system', 'mode-identity']

/**
 * Seed the four mode-identity skills with fixed UUIDs.
 *
 * `ON CONFLICT (id) DO NOTHING` so user edits persist across restarts and re-seeds. The bootstrap
 * also re-runs after migrations land so newly added modes get seeded automatically.
 */
/**
 * Seed the four mode-identity skills with fixed UUIDs.
 *
 * `dbInstance` is required because this function runs from `bootstrapDatabase()`, where the
 * top-level `db` export of db.server.ts has not been evaluated yet (it's exported AFTER
 * `await bootstrapDatabase()`). Callers outside the bootstrap path can pass the regular `db`.
 */
export async function seedModeIdentitySkills(dbInstance: DbLike): Promise<{ inserted: number }> {
	const now = new Date()
	const values = Object.values(MODE_SKILL_DEFAULTS).map((d) => ({
		id: d.id,
		name: d.name,
		description: d.description,
		content: d.content,
		tags: MODE_SKILL_TAGS,
		enabled: true,
		createdAt: now,
		updatedAt: now,
	}))
	// No-target ON CONFLICT DO NOTHING so we tolerate either an id PK collision (preserves user
	// edits across boots) OR a name uniqueness collision (handles a renamed/orphaned row from an
	// older boot — e.g. when the plan-mode UUID was bumped c003 → c023, the old row's
	// `system/mode-plan` name still occupies the unique index).
	const inserted = await dbInstance
		.insert(skills)
		.values(values)
		.onConflictDoNothing()
		.returning({ id: skills.id })
	return { inserted: inserted.length }
}

/**
 * Returns the live mode-identity prompt, preferring DB content (so user edits take effect)
 * with a fallback to the bundled default if the seed has not run yet for any reason.
 */
export async function loadModeIdentitySkill(mode: ChatMode): Promise<string> {
	const defaults = MODE_SKILL_DEFAULTS[mode]
	if (!defaults) return MODE_SKILL_DEFAULTS.chat.content
	const [row] = await db
		.select({ content: skills.content, enabled: skills.enabled })
		.from(skills)
		.where(eq(skills.id, defaults.id))
		.limit(1)
	if (row && row.enabled && typeof row.content === 'string' && row.content.trim().length > 0) {
		return row.content
	}
	return defaults.content
}

export const MODE_SKILL_IDS: Record<ChatMode, string> = {
	chat: MODE_SKILL_DEFAULTS.chat.id,
	research: MODE_SKILL_DEFAULTS.research.id,
	plan: MODE_SKILL_DEFAULTS.plan.id,
	agent: MODE_SKILL_DEFAULTS.agent.id,
}

export function getModeSkillDefault(mode: ChatMode): string {
	return MODE_SKILL_DEFAULTS[mode]?.content ?? MODE_SKILL_DEFAULTS.chat.content
}
