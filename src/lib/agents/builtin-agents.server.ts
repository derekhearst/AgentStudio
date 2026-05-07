import { eq } from 'drizzle-orm'
import { agents } from '$lib/agents/agents.schema'
import { skills } from '$lib/skills/skills.schema'
import type { db } from '$lib/db.server'

type DbLike = typeof db

/**
 * Built-in agents seeder.
 *
 * Replaces the prior 4-mode concept (`chat` | `research` | `plan` | `agent`) with four seeded
 * agents that the picker pins to the top of the dropdown. Custom user agents appear below.
 *
 * Idempotency: upserts agents by `builtin_key`. On conflict we refresh `name`, `role`,
 * `config.toolPolicy`, `anchor_prompt`, and `identity_skill_id` (so changes here propagate
 * across boots) but NEVER overwrite `system_prompt` after creation — the user can edit it via
 * the agents UI without it being clobbered.
 *
 * Identity skills: each built-in points at the existing `system/mode-*` skill UUID
 * (c001 / c002 / c023 / c004). Those skill rows are seeded inline by this function with
 * `ON CONFLICT (id) DO NOTHING`, so any user edits to the skill content survive — same
 * pattern the previous `seedModeIdentitySkills` used.
 *
 * Anchor prompts: short `[Agent changed to X] ...` sentence persisted to conversation
 * history when the user flips agents. Built-ins seed this; user agents leave it null and
 * the switcher falls back to a generic line.
 */

export const BUILTIN_AGENT_KEYS = ['chat', 'research', 'plan', 'autonomous'] as const
export type BuiltinAgentKey = (typeof BUILTIN_AGENT_KEYS)[number]

export const BUILTIN_AGENT_IDS: Record<BuiltinAgentKey, string> = {
	chat: '00000000-0000-4000-8000-0000000a6e71',
	research: '00000000-0000-4000-8000-0000000a6e72',
	plan: '00000000-0000-4000-8000-0000000a6e73',
	autonomous: '00000000-0000-4000-8000-0000000a6e74',
}

const BUILTIN_IDENTITY_SKILL_IDS: Record<BuiltinAgentKey, string> = {
	chat: '00000000-0000-4000-8000-00000000c001',
	research: '00000000-0000-4000-8000-00000000c002',
	plan: '00000000-0000-4000-8000-00000000c023',
	autonomous: '00000000-0000-4000-8000-00000000c004',
}

/**
 * Tools that read-only built-ins (Research, Plan) are allowed to call. Migrated from the old
 * `MODE_READ_ONLY_TOOLS` set in `mode-filter.ts`. Allow-list (not deny-list) so newly added
 * tools fail closed for these agents until explicitly audited.
 */
export const READ_ONLY_TOOL_NAMES: readonly string[] = [
	// Always-on essentials (core capability group).
	'ask_user',
	'propose_plan',
	'enable_capability',
	'web_search',
	// Sandbox: read-only inspection.
	'file_read',
	'list_directory',
	'search_files',
	'file_info',
	'browser_screenshot',
	'web_fetch',
	'pdf_read',
	'git_status',
	'git_log',
	'git_diff',
	// Skills: read-only.
	'list_skills',
	'read_skill',
	'read_skill_file',
	// Source control: read-only + the structured commit-draft helper.
	'list_my_repos',
	'list_pull_requests',
	'get_pull_request',
	'prepare_commit',
	// Projects + artifacts: read-only.
	'list_projects',
	'list_artifacts',
	'read_artifact',
	// Automations: read-only.
	'list_automations',
	// Memory: read-only retrieval.
	'recall_memory',
	'list_memory',
]

const IDENTITY_SKILL_TAGS = ['system', 'mode-identity']

const IDENTITY_SKILL_DEFAULTS: Record<
	BuiltinAgentKey,
	{ name: string; description: string; content: string }
> = {
	chat: {
		name: 'system/mode-chat',
		description: 'Conversational, collaborative posture for the Chat agent.',
		content: `# Agent: Chat

You are the Chat agent — the default workbench. Be conversational and collaborative.

- Keep replies tight: short paragraphs, bullets when they help, no preamble.
- Default to the most direct answer that's correct. Don't bury it under disclaimers.
- Ask a clarifying question when intent is genuinely ambiguous; otherwise pick the most plausible reading and proceed.
- When you take a tool action, state in one sentence what you're about to do and why before the call.
- You have read+write tool access. Use it. Don't quote shell commands at the user when you can run them yourself.
`,
	},
	research: {
		name: 'system/mode-research',
		description: 'Skeptical investigator posture for follow-up Q&A on Deep Research findings.',
		content: `# Agent: Research

You are the Research agent. A Deep Research run has typically already produced a cited report — your job is to discuss findings, dig into specific sources, and answer follow-up questions as a skeptical investigator.

- Cite sources for every factual claim. Prefer primary references; tag secondary ones explicitly.
- Distinguish "established" / "contested" / "speculative" findings. Don't flatten the gradient.
- When sources disagree, surface the disagreement. Don't pick one silently.
- Call out unknowns: state what you couldn't verify and what additional source would resolve it.
- Structure substantive answers as: claim → evidence → confidence.
- You have read-only tool access in this agent. To take action on findings, the user can switch to Chat or Autonomous.
`,
	},
	plan: {
		name: 'system/mode-plan',
		description: 'Plan-before-execute posture for the Plan agent.',
		content: `# Agent: Plan

You are the Plan agent. Think before acting; surface the plan before executing.

**Required workflow**: Before calling any non-readonly tool, you MUST call \`propose_plan\` with a structured plan. The user reviews it inline and explicitly approves or denies before any execution.

- The trigger is "about to take action," not "about to respond." Pure-information requests answer directly.
- Decompose ambiguous requests into discrete, testable steps. Each step should have a single owner and a verifiable outcome.
- Prefer reversible operations early; defer destructive ones until late, after a checkpoint.
- After approval, execute the plan as proposed. If you need to deviate, call \`propose_plan\` again with the revision — don't free-form past the approval.
- Be specific about risks and rollback. "Could fail" is not a risk; "third-party API rate-limits at 100 req/min, batch will hit 300" is.

The schema for \`propose_plan\` is the source of truth for required fields — read it once and follow it.
`,
	},
	autonomous: {
		name: 'system/mode-agent',
		description: 'Autonomous executor posture for the Autonomous agent.',
		content: `# Agent: Autonomous

You are the Autonomous agent. Execute autonomously. Minimize interruptions.

- You have full read+write tool access. Use it without asking permission for unambiguous next steps.
- Report progress concisely: short status lines, not paragraphs. The user is watching the diff, not reading prose.
- Only stop for: genuine ambiguity that changes the goal, irreversible consequences, hard failures you can't work around.
- Long-running runs are expected here — chain tool calls aggressively, don't bail early because "this is taking a while."
- When you finish or hit a real blocker, summarize: what was done, what's left, what needs human input. Three bullets max.
- Don't chain exploratory tools when the goal is already clear. Read the task, plan the path, execute it.
`,
	},
}

const ANCHOR_PROMPTS: Record<BuiltinAgentKey, string> = {
	chat: '[Agent changed to Chat] You are now the Chat agent. Be conversational and collaborative. Keep responses concise; ask clarifying questions when intent is ambiguous.',
	research:
		'[Agent changed to Research] You are now the Research agent. Be a skeptical investigator. Cite sources for every factual claim, prefer primary references, and call out unknowns explicitly.',
	plan: '[Agent changed to Plan] You are now the Plan agent. Propose a structured plan with explicit success criteria and risk callouts before taking any actions. Wait for approval before executing.',
	autonomous:
		'[Agent changed to Autonomous] You are now the Autonomous agent. Execute autonomously with minimal interruptions. Report progress concisely; only stop for blocking decisions or hard failures.',
}

const ROLE_DESCRIPTIONS: Record<BuiltinAgentKey, string> = {
	chat: 'Conversational and collaborative.',
	research: 'Skeptical investigator; cites sources.',
	plan: 'Proposes structured plans before acting.',
	autonomous: 'Executes autonomously with minimal interruption.',
}

const NAMES: Record<BuiltinAgentKey, string> = {
	chat: 'Chat',
	research: 'Research',
	plan: 'Plan',
	autonomous: 'Autonomous',
}

function buildToolPolicyConfig(key: BuiltinAgentKey): Record<string, unknown> {
	if (key === 'research' || key === 'plan') {
		return { toolPolicy: { kind: 'readOnly', allow: READ_ONLY_TOOL_NAMES } }
	}
	return { toolPolicy: { kind: 'unrestricted' } }
}

/**
 * Seed the four mode-identity skills + four built-in agents in a single transaction.
 *
 * `dbInstance` is required because this runs from `bootstrapDatabase()` where the top-level
 * `db` export of db.server.ts has not been evaluated yet (it's exported AFTER
 * `await bootstrapDatabase()`). Callers outside the bootstrap path can pass the regular `db`.
 */
export async function seedBuiltinAgents(
	dbInstance: DbLike,
): Promise<{ skillsInserted: number; agentsUpserted: number }> {
	const now = new Date()

	// 1. Seed identity skills first (agents reference them via FK-by-convention).
	const skillRows = (Object.keys(IDENTITY_SKILL_DEFAULTS) as BuiltinAgentKey[]).map((key) => {
		const defaults = IDENTITY_SKILL_DEFAULTS[key]
		return {
			id: BUILTIN_IDENTITY_SKILL_IDS[key],
			name: defaults.name,
			description: defaults.description,
			content: defaults.content,
			tags: IDENTITY_SKILL_TAGS,
			enabled: true,
			createdAt: now,
			updatedAt: now,
		}
	})
	const insertedSkills = await dbInstance
		.insert(skills)
		.values(skillRows)
		.onConflictDoNothing()
		.returning({ id: skills.id })

	// 2. Upsert agents by builtin_key. On conflict refresh metadata but never clobber
	//    user edits to system_prompt. (system_prompt is a fallback; the live posture comes
	//    from the linked identity skill, which the user can edit independently.)
	let agentsUpserted = 0
	for (const key of BUILTIN_AGENT_KEYS) {
		const id = BUILTIN_AGENT_IDS[key]
		const skillContent = IDENTITY_SKILL_DEFAULTS[key].content
		// ON CONFLICT (id) — the partial unique index on builtin_key isn't a valid ON CONFLICT
		// target without a WHERE clause, but each built-in agent has a stable UUID so id-based
		// conflict handling is just as deterministic. Refresh metadata fields but never clobber
		// system_prompt (the user can edit it via the agents UI without it being overwritten).
		await dbInstance
			.insert(agents)
			.values({
				id,
				name: NAMES[key],
				role: ROLE_DESCRIPTIONS[key],
				systemPrompt: skillContent,
				model: 'anthropic/claude-sonnet-4',
				config: buildToolPolicyConfig(key),
				status: 'idle',
				kind: 'orchestrator',
				identitySkillId: BUILTIN_IDENTITY_SKILL_IDS[key],
				builtinKey: key,
				anchorPrompt: ANCHOR_PROMPTS[key],
				createdAt: now,
			})
			.onConflictDoUpdate({
				target: agents.id,
				set: {
					name: NAMES[key],
					role: ROLE_DESCRIPTIONS[key],
					config: buildToolPolicyConfig(key),
					identitySkillId: BUILTIN_IDENTITY_SKILL_IDS[key],
					builtinKey: key,
					anchorPrompt: ANCHOR_PROMPTS[key],
					// Bump kind in case the enum gained a value later — keeps existing rows aligned.
					kind: 'orchestrator',
				},
			})
		agentsUpserted++
	}

	return { skillsInserted: insertedSkills.length, agentsUpserted }
}

/**
 * Lookup a built-in agent's id by its key. Used by the chat page to resolve the default
 * Chat agent when a user has no `defaultAgentId` preference set.
 */
export async function getBuiltinAgentId(
	dbInstance: DbLike,
	key: BuiltinAgentKey,
): Promise<string | null> {
	const [row] = await dbInstance
		.select({ id: agents.id })
		.from(agents)
		.where(eq(agents.builtinKey, key))
		.limit(1)
	return row?.id ?? null
}
