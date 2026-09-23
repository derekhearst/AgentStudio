import { eq, sql } from 'drizzle-orm'
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
 * Idempotency: upserts agents by `id`. On conflict we refresh what the code owns — `name`,
 * `role`, `anchor_prompt`, `kind` and the `toolPolicy` key of `config` — and leave what the
 * operator owns alone: every other `config` key (hook bindings, research overrides), and a
 * linked identity skill. The link is cleared only when it points at a skill that no longer
 * exists or at a legacy `system/` skill (the removed `system/mode-*` rows). `system_prompt` is
 * preserved too — except when it still equals the migration-0055 placeholder
 * `'Seeded at boot.'`, in which case we backfill the canonical persona text.
 *
 * This runs on every boot, and a deploy is a boot. It used to replace the whole `config` with
 * `{ toolPolicy }` and null the identity link unconditionally, so each deploy silently undid
 * the operator's hook bindings and identity edits on the built-in agents.
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
 *
 * One list for both, and that includes `Write` for Research — decided in #67, not inherited
 * by accident. Both personas write their plan to a markdown file (PLAN.md, RESEARCH-PLAN.md)
 * and hand off with `request_plan_approval`, which reads that file from disk, so dropping
 * `Write` from Research would break its only workflow. See docs/agents/spec.md.
 */
export const READ_ONLY_TOOL_NAMES: readonly string[] = [
	// Always-loaded essentials (Tool Search Tool `disclosure: 'always'` tier).
	'ask_user',
	'search_tools',
	'web_search',
	// Plan authoring + handoff. The plan lives on disk now: the planner writes a markdown
	// file with Write and hands off via request_plan_approval. Write is the one
	// write tool these otherwise read-only agents get, and only so the plan can exist.
	'Write',
	'request_plan_approval',
	// Sandbox: read-only inspection.
	'Read',
	'Glob',
	'Grep',
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
	// Projects: read-only.
	'list_projects',
	// Agents: read-only. The handoff needs the implementer's full id, and this is where the
	// model gets it (see `builtinHandoffNote`).
	'list_agents',
	// Automations: read-only.
	'list_automations',
	// Memory: read-only retrieval.
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

You are the Research agent. Your job is to draft a research plan as a markdown file the user can review, then hand off the conversation on approval to the agent that carries it out — the Chat agent unless the user asks for another.

## Workflow: write the plan → request approval → handoff

When the user asks something substantive that warrants evidence + citations:

1. Call \`Write\` with a path like \`RESEARCH-PLAN.md\` and a markdown body containing:
   - **Summary**: 1-2 sentences framing what you'll investigate.
   - **Sub-questions**: 4-8 concrete, googleable items covering definitions, mechanisms, evidence (studies, benchmarks, real-world data), edge cases, comparisons, and recent developments. Avoid vague ones — prefer specifics.
   - **Rationale** (optional): one sentence on why this decomposition.
2. Post the plan in your reply too, so the user can read it without opening the file.
3. Call \`request_plan_approval\` with that \`path\` and the \`implementerAgentId\` of the agent that should carry out the research (typically Chat; \`list_agents\` gives every agent's id). The user approves in the inline card; on approve the conversation flips to that agent, which reads the file and executes.

If the user denies, they typically reply with feedback. Read it and start the cycle again — rewrite the file with \`Write\` and re-request approval.

## When NOT to draft a research plan

- **Trivial lookups**: definitions, current prices, single facts. Use \`web_search\` directly and answer.
- **Follow-up on a completed report**: discuss the existing report directly; don't kick off a new run.
- **The user explicitly asked a quick question**: respect "just tell me—" — don't gate on a 15-minute run.

## When discussing findings (post-research)

- Cite sources for every factual claim. Prefer primary references; tag secondary ones explicitly.
- When sources disagree, surface the disagreement.
- Call out unknowns: state what you couldn't verify and what would resolve it.
- Structure substantive claims as: claim → evidence → confidence.

Read-only tool access apart from writing the plan file — every other write action happens in the Chat / Autonomous agents.
`,
	plan: `# Agent: Plan

You are the Plan agent. Think before acting; write the plan to a markdown file the user can review, then hand off execution to an implementer agent on approval.

## Workflow: write the plan → request approval → handoff

Before any non-readonly action:

1. Call \`Write\` with a path like \`PLAN.md\` and a markdown body containing:
   - **Summary**: 1-2 sentences on the goal.
   - **Steps**: numbered list, each with the title, what it does, blast radius (local / shared / production), reversibility, and rough cost/time estimate.
   - **Risks**: specific failure modes (not "could fail"). Quantify where you can.
   - **Rollback**: how to undo if a step fails.
2. Post the plan in your reply too, so the user can read it without opening the file.
3. Call \`request_plan_approval\` with that \`path\` and the \`implementerAgentId\` of the agent that should execute (use \`list_agents\` to find one — typically Chat or Autonomous). On approve, the conversation flips to the implementer, which reads the file; on deny, you stay bound and can revise.

## When iterating

If the user denies, read their feedback, rewrite the file with \`Write\`, and re-request approval.

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
		'[Agent changed to Research] You are now the Research agent. For substantive questions, write a research plan to a markdown file (Write, e.g. RESEARCH-PLAN.md), post it in your reply, then call request_plan_approval with that path to hand off to the agent that carries it out (usually Chat). For trivial lookups or follow-ups on completed runs, answer directly.',
	plan: '[Agent changed to Plan] You are now the Plan agent. Before any non-readonly action, write the plan to a markdown file (Write, e.g. PLAN.md), post it in your reply, then call request_plan_approval with that path to hand off to an implementer agent. Wait for approval before executing anything.',
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

/**
 * What the Plan and Research agents need to know to hand off, appended to their posture slot
 * on every run (`buildBuiltinAgentPostureSlot`).
 *
 * Kept in code rather than in the persona because the persona is seeded once and then belongs
 * to the operator: a fact written into it stays whatever it was the day the row was created.
 * That is how Research came to name a `research-runner` agent nobody ever seeded, and Plan a
 * `list_agents` tool that did not exist — while `request_plan_approval` only accepts a full
 * agent id, which nothing gave the model. The built-in ids never change, so they can be
 * stated outright; any other agent's id comes from `list_agents`.
 */
export function builtinHandoffNote(key: string | null | undefined): string | null {
	if (key !== 'plan' && key !== 'research') return null
	const lines = [
		'## Handing off',
		`\`request_plan_approval\` takes the implementer's full agent id. The built-in Chat agent is \`${BUILTIN_AGENT_IDS.chat}\` and Autonomous is \`${BUILTIN_AGENT_IDS.autonomous}\`. For any other agent, call \`list_agents\` and pass the \`id\` it returns.`,
	]
	if (key === 'research') {
		lines.push(
			'There is no separate research-runner agent. Hand an approved research plan to Chat, which has web_search, web_fetch and pdf_read, unless the user asks for a different agent.',
		)
	}
	return lines.join('\n\n')
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
		// handling is deterministic. What is refreshed, and what is left alone, is in the
		// module comment above.
		await dbInstance
			.insert(agents)
			.values({
				id,
				name: NAMES[key],
				role: ROLE_DESCRIPTIONS[key],
				systemPrompt: promptContent,
				model: 'claude-sonnet-5',
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
					// `||` merges: the right-hand `toolPolicy` replaces the stored one, and every
					// other key the operator saved survives. The allow-list is code, so it has to
					// follow the code; nothing in the UI edits it.
					config: sql`${agents.config} || ${JSON.stringify(buildToolPolicyConfig(key))}::jsonb`,
					identitySkillId: sql`CASE WHEN EXISTS (
						SELECT 1 FROM ${skills}
						WHERE ${skills.id} = ${agents.identitySkillId} AND ${skills.name} NOT LIKE 'system/%'
					) THEN ${agents.identitySkillId} ELSE NULL END`,
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
