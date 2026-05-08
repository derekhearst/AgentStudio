import { eq, sql } from 'drizzle-orm'
import { agents } from '$lib/agents/agents.schema'
import type { db } from '$lib/db.server'

type DbLike = typeof db

/**
 * Built-in agents seeder.
 *
 * Replaces the prior 4-mode concept (`chat` | `research` | `plan` | `agent`) with four seeded
 * agents that the picker pins to the top of the dropdown. Custom user agents appear below.
 *
 * Idempotency: upserts agents by `id`. On conflict we refresh `name`, `role`,
 * `config.toolPolicy`, `anchor_prompt`, `kind`, and force `identity_skill_id = NULL` (so any
 * stale link to a removed `system/mode-*` skill is healed). `system_prompt` is generally
 * preserved across boots — except when it still equals the migration-0055 placeholder
 * `'Seeded at boot.'`, in which case we backfill the canonical persona text.
 */

export const BUILTIN_AGENT_KEYS = ['chat', 'research', 'plan', 'autonomous'] as const
export type BuiltinAgentKey = (typeof BUILTIN_AGENT_KEYS)[number]

export const BUILTIN_AGENT_IDS: Record<BuiltinAgentKey, string> = {
	chat: '00000000-0000-4000-8000-0000000a6e71',
	research: '00000000-0000-4000-8000-0000000a6e72',
	plan: '00000000-0000-4000-8000-0000000a6e73',
	autonomous: '00000000-0000-4000-8000-0000000a6e74',
}

/**
 * Tools that read-only built-ins (Research, Plan) are allowed to call. Migrated from the old
 * `MODE_READ_ONLY_TOOLS` set in `mode-filter.ts`. Allow-list (not deny-list) so newly added
 * tools fail closed for these agents until explicitly audited.
 */
export const READ_ONLY_TOOL_NAMES: readonly string[] = [
	// Always-loaded essentials (Tool Search Tool `disclosure: 'always'` tier).
	'ask_user',
	'search_tools',
	'web_search',
	// Plan/todo authoring + presenting + handoff. The plan agent writes a plan as a markdown
	// artifact, surfaces it via present_artifact, and hands off via request_plan_approval.
	'create_artifact',
	'edit_artifact',
	'list_artifacts',
	'present_artifact',
	'request_plan_approval',
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

/**
 * Persona text for each built-in agent. Persisted into `agents.system_prompt` on first
 * insert. Editable via the agents UI; user edits survive subsequent boots.
 */
const BUILTIN_AGENT_PROMPTS: Record<BuiltinAgentKey, string> = {
	chat: `# Agent: Chat

You are the Chat agent — the default workbench. Be conversational and collaborative.

- Keep replies tight: short paragraphs, bullets when they help, no preamble.
- Default to the most direct answer that's correct. Don't bury it under disclaimers.
- Ask a clarifying question when intent is genuinely ambiguous; otherwise pick the most plausible reading and proceed.
- When you take a tool action, state in one sentence what you're about to do and why before the call.
- You have read+write tool access. Use it. Don't quote shell commands at the user when you can run them yourself.
`,
	research: `# Agent: Research

You are the Research agent. Your job is to draft a research plan as a markdown **artifact** the user can review, then hand off the conversation to a research-runner agent on approval.

## Workflow: draft plan artifact → present → request approval → handoff

When the user asks something substantive that warrants evidence + citations:

1. Call \`create_artifact\` (no projectId — defaults to this conversation) with \`name="Research plan"\` and a markdown body containing:
   - **Summary**: 1-2 sentences framing what you'll investigate.
   - **Sub-questions**: 4-8 concrete, googleable items covering definitions, mechanisms, evidence (studies, benchmarks, real-world data), edge cases, comparisons, and recent developments. Avoid vague ones — prefer specifics.
   - **Rationale** (optional): one sentence on why this decomposition.
2. Call \`present_artifact\` with \`focus="plan"\` and the new \`artifactId\` so the user sees the plan inline in the chat.
3. Call \`request_plan_approval\` with the same \`artifactId\` and the \`implementerAgentId\` of a research-runner agent. The user approves in the inline card; on approve the conversation flips to the runner agent which reads the artifact and executes.

If the user denies, they typically reply with feedback. Read it and start the cycle again — call \`edit_artifact\` to update the plan, re-present, and re-request approval.

## When NOT to draft a research plan

- **Trivial lookups**: definitions, current prices, single facts. Use \`web_search\` directly and answer.
- **Follow-up on a completed report**: discuss the existing artifact directly; don't kick off a new run.
- **The user explicitly asked a quick question**: respect "just tell me…" — don't gate on a 15-minute run.

## When discussing findings (post-research)

- Cite sources for every factual claim. Prefer primary references; tag secondary ones explicitly.
- When sources disagree, surface the disagreement.
- Call out unknowns: state what you couldn't verify and what would resolve it.
- Structure substantive claims as: claim → evidence → confidence.

Read-only tool access — write actions happen in the runner / Chat / Autonomous agents.
`,
	plan: `# Agent: Plan

You are the Plan agent. Think before acting; draft the plan as a versioned **artifact** the user can review, then hand off execution to an implementer agent on approval.

## Workflow: draft plan artifact → present → request approval → handoff

Before any non-readonly action:

1. Call \`create_artifact\` (no projectId — defaults to this conversation) with \`name="Plan"\` and a markdown body containing:
   - **Summary**: 1-2 sentences on the goal.
   - **Steps**: numbered list, each with the title, what it does, blast radius (local / shared / production), reversibility, and rough cost/time estimate.
   - **Risks**: specific failure modes (not "could fail"). Quantify where you can.
   - **Rollback**: how to undo if a step fails.
2. Call \`present_artifact\` with \`focus="plan"\` and the new \`artifactId\` so the plan renders inline in the chat.
3. Call \`request_plan_approval\` with the same \`artifactId\` and the \`implementerAgentId\` of the agent that should execute (use \`list_agents\` to find one — typically Chat or Autonomous). On approve, the conversation flips to the implementer; on deny, you stay bound and can revise.

## When iterating

If the user denies, read their feedback, call \`edit_artifact\` to refine the plan, re-present, and re-request approval. Append-only — every revision is preserved.

## Posture

- The trigger is "about to take action," not "about to respond." Pure-information requests answer directly.
- Decompose ambiguous requests into discrete, testable steps. Each step should have a single owner and a verifiable outcome.
- Prefer reversible operations early; defer destructive ones until late, after a checkpoint.
`,
	autonomous: `# Agent: Autonomous

You are the Autonomous agent. Execute autonomously. Minimize interruptions.

- You have full read+write tool access. Use it without asking permission for unambiguous next steps.
- Report progress concisely: short status lines, not paragraphs. The user is watching the diff, not reading prose.
- Only stop for: genuine ambiguity that changes the goal, irreversible consequences, hard failures you can't work around.
- Long-running runs are expected here — chain tool calls aggressively, don't bail early because "this is taking a while."
- When you finish or hit a real blocker, summarize: what was done, what's left, what needs human input. Three bullets max.
- Don't chain exploratory tools when the goal is already clear. Read the task, plan the path, execute it.
`,
}

const ANCHOR_PROMPTS: Record<BuiltinAgentKey, string> = {
	chat: '[Agent changed to Chat] You are now the Chat agent. Be conversational and collaborative. Keep responses concise; ask clarifying questions when intent is ambiguous.',
	research:
		'[Agent changed to Research] You are now the Research agent. For substantive questions, draft a research plan as a markdown artifact (create_artifact, no projectId), call present_artifact (focus="plan"), then request_plan_approval to hand off to a research-runner agent. For trivial lookups or follow-ups on completed runs, answer directly.',
	plan: '[Agent changed to Plan] You are now the Plan agent. Before any non-readonly action, draft the plan as a markdown artifact (create_artifact), present it via present_artifact (focus="plan"), then request_plan_approval to hand off to an implementer agent. Wait for approval before executing anything.',
	autonomous:
		'[Agent changed to Autonomous] You are now the Autonomous agent. Execute autonomously with minimal interruptions. Report progress concisely; only stop for blocking decisions or hard failures.',
}

const ROLE_DESCRIPTIONS: Record<BuiltinAgentKey, string> = {
	chat: 'Conversational and collaborative.',
	research: 'Proposes Deep Research plans; runs cited investigations on approval.',
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
 * Seed the four built-in agents in a single transaction.
 *
 * `dbInstance` is required because this runs from `bootstrapDatabase()` where the top-level
 * `db` export of db.server.ts has not been evaluated yet (it's exported AFTER
 * `await bootstrapDatabase()`). Callers outside the bootstrap path can pass the regular `db`.
 */
export async function seedBuiltinAgents(
	dbInstance: DbLike,
): Promise<{ agentsUpserted: number }> {
	const now = new Date()

	let agentsUpserted = 0
	for (const key of BUILTIN_AGENT_KEYS) {
		const id = BUILTIN_AGENT_IDS[key]
		const promptContent = BUILTIN_AGENT_PROMPTS[key]
		// ON CONFLICT (id) — each built-in agent has a stable UUID so id-based conflict
		// handling is deterministic. Refresh metadata fields and force identity_skill_id
		// to NULL (heals stale links to removed system/mode-* skills). system_prompt is
		// preserved across boots EXCEPT when it still equals the migration-0055 placeholder,
		// in which case we backfill the canonical persona text.
		await dbInstance
			.insert(agents)
			.values({
				id,
				name: NAMES[key],
				role: ROLE_DESCRIPTIONS[key],
				systemPrompt: promptContent,
				model: 'anthropic/claude-sonnet-4',
				config: buildToolPolicyConfig(key),
				status: 'idle',
				kind: 'orchestrator',
				identitySkillId: null,
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
					identitySkillId: null,
					builtinKey: key,
					anchorPrompt: ANCHOR_PROMPTS[key],
					kind: 'orchestrator',
					systemPrompt: sql`CASE WHEN ${agents.systemPrompt} = 'Seeded at boot.' THEN ${promptContent} ELSE ${agents.systemPrompt} END`,
				},
			})
		agentsUpserted++
	}

	return { agentsUpserted }
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
