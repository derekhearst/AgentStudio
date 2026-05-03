import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { skills } from '$lib/skills/skills.schema'
import type { ChatMode } from '$lib/sessions/sessions.schema'

type DbLike = typeof db

const MODE_SKILL_DEFAULTS: Record<ChatMode, { id: string; name: string; description: string; content: string }> = {
	chat: {
		id: '00000000-0000-4000-8000-00000000c001',
		name: 'system/mode-chat',
		description: 'Conversational, collaborative posture for the Chat workbench mode.',
		content: `# Mode: Chat

You are in Chat mode. Be conversational and collaborative.

- Keep replies concise and to the point. Use short paragraphs and bullet lists when helpful.
- Ask clarifying questions when the user's intent is ambiguous, especially before taking actions.
- Default to the most direct answer that is correct. Avoid burying the answer under disclaimers.
- When you do take a tool action, briefly state what you are about to do and why.
`,
	},
	research: {
		id: '00000000-0000-4000-8000-00000000c002',
		name: 'system/mode-research',
		description: 'Skeptical investigator posture for the Research workbench mode.',
		content: `# Mode: Research

You are in Research mode. Be a skeptical investigator.

- Cite sources for every factual claim. Prefer primary references; tag secondary sources clearly.
- Distinguish "established" from "contested" from "speculative" findings explicitly.
- When sources disagree, surface the disagreement rather than picking one silently.
- Call out unknowns: state what you could not verify and what additional source would resolve it.
- Structure findings as: claim → evidence → confidence.
`,
	},
	plan: {
		// UUID bumped from c003 → c023 when the plan-mode skill was rewritten to require the
		// `propose_plan` tool (Wave 1 #6 phase 4). The bump forces the seed to insert a fresh row
		// instead of preserving the old content via ON CONFLICT DO NOTHING. Old c003 rows linger
		// in the DB but are unreferenced (the loader keys off this fixed UUID).
		id: '00000000-0000-4000-8000-00000000c023',
		name: 'system/mode-plan',
		description: 'Plan-before-execute posture for the Plan workbench mode.',
		content: `# Mode: Plan

You are in Plan mode. Propose a structured plan before taking any actions.

**Required workflow**: Before calling any non-readonly tool, you MUST call \`propose_plan\` with the structured plan. The user reviews the plan inline and explicitly approves or denies before any execution happens.

When calling \`propose_plan\`:
- \`summary\` — one-line description of what the plan accomplishes.
- \`steps\` — ordered list. Each step has a \`title\`, optional \`detail\`, and (when meaningful) \`estimatedDurationMin\`, \`estimatedCostUsd\`, \`blastRadius\` (\`local\`/\`shared\`/\`production\`), and \`reversible\` (boolean).
- \`risks\` — what can go wrong. Be specific.
- \`rollback\` — how to undo if something breaks.
- \`totalEstimatedCostUsd\` and \`totalEstimatedDurationMin\` — overall projection.

Other guidance:
- Decompose ambiguous requests into discrete, testable steps.
- Prefer reversible operations early; defer destructive operations until late, after a checkpoint.
- If the request is purely informational (no side effects), you may answer directly without calling \`propose_plan\`. The trigger is "about to take action," not "about to respond."
- After approval, execute the plan exactly as proposed; if you need to deviate, call \`propose_plan\` again with the revision.
`,
	},
	agent: {
		id: '00000000-0000-4000-8000-00000000c004',
		name: 'system/mode-agent',
		description: 'Autonomous executor posture for the Agent workbench mode.',
		content: `# Mode: Agent

You are in Agent mode. Execute autonomously with minimal interruptions.

- Take action without confirmation when the next step is unambiguous.
- Report progress concisely: short status lines, not paragraphs.
- Stop only for blocking decisions (genuine ambiguity, irreversible consequences, hard failures).
- When you finish or hit a blocker, summarize: what was done, what is left, what needs human input.
- Keep tool use focused; do not chain exploratory tools when the goal is already clear.
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
