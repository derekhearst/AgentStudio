/**
 * System-prompt slot builders, extracted from `stream-prep.server.ts`.
 *
 * Each builder returns either a `ContextSlot` (used by the slot-rendering pipeline) or, for
 * `buildSkillSummariesText` / `resolveSkillTopK`, a small piece the caller embeds elsewhere.
 *
 * Pure-ish: the builders read from the DB and from external services (memory recall) but
 * have no in-process state. Failures inside best-effort builders (memory, project context)
 * are logged and the builder returns null — slot assembly never blocks the chat path.
 */

import { eq } from 'drizzle-orm'
import { listRelevantSkillSummaries, listSkillSummaries } from '$lib/skills/skills.server'
import { recallForUser, renderMemoryContext } from '$lib/memory/memory.server'
import type { ContextSlot } from '$lib/context/slots.server'
import { logger } from '$lib/observability/logger'
import { loadAgentIdentityContent } from '$lib/chat/agent-switch.server'
import { buildOrchestratorPrompt } from '$lib/agents/orchestrator'
import { builtinHandoffNote } from '$lib/agents/builtin-agents.server'
import { DELEGATION_POLICY_LINES, SUBAGENT_RESULT_POLICY_LINES } from '$lib/agents/subagent-result'
import { db } from '$lib/db.server'
import type { agents as agentsTable } from '$lib/agents/agents.schema'
import type { getSettings } from '$lib/settings'

type AppSettings = Awaited<ReturnType<typeof getSettings>>
type AgentRow = typeof agentsTable.$inferSelect

// Slot names whose content recomputes per query (skill top-K relevance, companion-skill
// groups, memory recall) — they're appended after the cache_control boundary so the
// stable prefix doesn't cache-miss every turn.
export const VOLATILE_SLOT_NAMES = new Set(['memory', 'skills', 'companion_skills'])

/**
 * Build the markdown bullet list of skill summaries for the system prompt's
 * skills slot. Picks the relevant top-K when the user has a query, otherwise
 * lists everything (limits applied by the listSummaries helpers themselves).
 *
 * Returns `undefined` when no skills exist so callers can omit the slot.
 */
export async function buildSkillSummariesText(input: {
	/** Whose exclusion rules the query is held to before it is embedded. */
	userId: string
	userQuery: string | undefined
	skillTopK: number
}): Promise<string | undefined> {
	const trimmed = input.userQuery?.trim() ?? ''
	const skillSummaries = trimmed.length > 0
		? await listRelevantSkillSummaries(trimmed, input.skillTopK, { userId: input.userId })
		: await listSkillSummaries()
	if (skillSummaries.length === 0) return undefined
	return skillSummaries
		.map((s) => {
			const fileNames = s.files.map((f) => f.name).join(', ')
			return `- ${s.name}: ${s.description}${fileNames ? ` [files: ${fileNames}]` : ''}`
		})
		.join('\n')
}

/** Read `contextConfig.skillTopK` with the documented default of 8 and a >=1 floor. */
export function resolveSkillTopK(settings: AppSettings): number {
	const raw = (settings.contextConfig as { skillTopK?: number } | null)?.skillTopK ?? 8
	return Math.max(1, raw)
}

/**
 * Run memory-palace recall for the user's query and produce the rendered context
 * slot if any drawers came back. Swallows recall errors with a warning — recall
 * is a best-effort enhancement that must never block the chat path.
 */
export async function buildMemoryRecallSlot(input: {
	settings: AppSettings
	userId: string
	userQuery: string | undefined
}): Promise<ContextSlot | null> {
	const userQuery = input.userQuery?.trim() ?? ''
	if (userQuery.length === 0) return null

	const memoryConfig = (input.settings.memoryConfig ?? null) as {
		enabled?: boolean
		topK?: number
		useRerank?: boolean
		rerankModel?: string
	} | null

	if (memoryConfig?.enabled === false) return null

	try {
		const recalled = await recallForUser(input.userId, userQuery, {
			topK: memoryConfig?.topK ?? 5,
			useRerank: memoryConfig?.useRerank ?? false,
			rerankModel: memoryConfig?.rerankModel,
		})
		const memoryBlock = renderMemoryContext(recalled)
		if (!memoryBlock) return null
		return {
			name: 'memory',
			priority: 60,
			content: memoryBlock,
			truncationStrategy: 'truncate-end',
		}
	} catch (err) {
		logger.warn('[memory] recall failed', { err })
		return null
	}
}

/**
 * Build the built-in-agent posture slot. Non-`chat` built-in agents
 * (research / plan / autonomous) overlay their identity-skill content as a
 * posture slot at priority 95 — under the orchestrator identity at 100, above
 * the project context at 80. Returns null for the `chat` built-in (which IS
 * the default orchestrator persona) and for custom agents.
 *
 * Plan and Research also get the handoff facts (`builtinHandoffNote`): the ids
 * `request_plan_approval` needs, which the operator-owned persona cannot be
 * trusted to carry.
 */
export async function buildBuiltinAgentPostureSlot(agent: AgentRow): Promise<ContextSlot | null> {
	if (!agent.builtinKey || agent.builtinKey === 'chat') return null
	const posture = await loadAgentIdentityContent(agent)
	const handoff = builtinHandoffNote(agent.builtinKey)
	return {
		name: `agent_${agent.builtinKey}`,
		priority: 95,
		content: handoff ? `${posture}\n\n${handoff}` : posture,
	}
}

/**
 * Build the identity slot. Orchestrator agents use the shared orchestrator
 * prompt; custom agents load their identity skill (or systemPrompt fallback)
 * and expand any `@import skill-name` fragments. Wave 5 #22 phases 2 + 5.
 *
 * Fragment-expansion failures are logged and the raw identity is used so
 * malformed @imports never block the chat path.
 */
export async function buildIdentitySlot(agent: AgentRow): Promise<ContextSlot> {
	const isOrchestrator = agent.builtinKey != null
	if (isOrchestrator) {
		return { name: 'identity', priority: 100, content: await buildOrchestratorPrompt() }
	}

	let identityContent = await loadAgentIdentityContent(agent)
	try {
		const { expandFragments } = await import('$lib/agents/fragment-expand')
		const { skills: skillsTable } = await import('$lib/skills/skills.schema')
		identityContent = await expandFragments(identityContent, async (name) => {
			const [row] = await db
				.select({ content: skillsTable.content, enabled: skillsTable.enabled })
				.from(skillsTable)
				.where(eq(skillsTable.name, name))
				.limit(1)
			if (!row || !row.enabled) return null
			return row.content
		})
	} catch (err) {
		logger.warn('[chat] fragment expansion failed, using raw identity content', { err })
	}
	return { name: 'identity', priority: 100, content: identityContent }
}

/** How many knowledge filenames the slot lists before it stops and says how many remain. */
const KNOWLEDGE_NAMES_IN_SLOT = 25

/**
 * The knowledge-directory paragraph, or '' when the project has no knowledge files.
 *
 * Never throws: a project-context slot is a convenience, and an unreadable sandbox
 * directory must not be the reason a turn fails to start.
 */
async function listKnowledgeFilesForSlot(userId: string, projectId: string): Promise<string> {
	try {
		const { KNOWLEDGE_DIR, listKnowledgeFiles } = await import('$lib/projects/project-knowledge.server')
		const files = await listKnowledgeFiles(userId, projectId)
		if (files.length === 0) return ''

		const shown = files.slice(0, KNOWLEDGE_NAMES_IN_SLOT)
		const names = shown.map((file) => `- ${file.name}`).join('\n')
		const remaining =
			files.length > shown.length
				? `\n- …and ${files.length - shown.length} more; list the directory to see them.`
				: ''
		return `\n\n### Project knowledge\n\nReference material the operator attached to this project, in \`${KNOWLEDGE_DIR}/\` inside the working directory. Read one when it is relevant; do not edit or delete them.\n\n${names}${remaining}`
	} catch (err) {
		logger.warn('[chat] could not list project knowledge for the context slot', { err })
		return ''
	}
}

/**
 * Resolve the project-context slot for a conversation. When the conversation
 * is bound to a project (via set_project_context), the agent gets a high-
 * priority slot describing the project so it doesn't have to re-list projects
 * each turn. Returns null when there's no project, the project doesn't belong
 * to the user, or the lookup fails.
 */
export async function buildProjectContextSlot(input: {
	projectId: string | null
	userId: string
}): Promise<ContextSlot | null> {
	if (!input.projectId) return null
	try {
		const { getProjectById } = await import('$lib/projects/projects.server')
		const project = await getProjectById(input.projectId)
		if (!project || project.userId !== input.userId) return null
		const description = project.description ? `\nDescription: ${project.description}` : ''
		/*
		 * #23 — the operator's standing instructions for this project.
		 *
		 * Injected here rather than written out as a `CLAUDE.md`, which was the earlier
		 * plan. `CLAUDE.md` only loads when `settingSources` includes `'project'`, which is
		 * gated on `projects.settings_trusted` — so the operator's own words would silently
		 * stop loading for any project whose *repo* config they had not accepted. Those are
		 * two different questions, and this is the one that is never gated. Headed and
		 * fenced so a long instruction block cannot be read as the end of the slot.
		 */
		const instructions = project.instructions?.trim()
			? `\n\n### Project instructions\n\nStanding instructions from the operator for this project. They are directions, not content to summarise.\n\n${project.instructions.trim()}`
			: ''
		/*
		 * #23 — the project's knowledge files, named but not read.
		 *
		 * Naming them is the whole job: they sit in the working directory the agent is
		 * already in, so `Read` and `Grep` reach them with no retrieval layer at all — but
		 * an agent that does not know a directory exists never looks in it, and `.agentstudio`
		 * is hidden, so a `Glob` would not surface it either. Names and nothing else: the
		 * contents are what the tools are for, and a PDF pasted into a system prompt would
		 * cost a context window to say what one `Read` says on demand.
		 */
		const knowledge = await listKnowledgeFilesForSlot(input.userId, project.id)

		return {
			name: 'project_context',
			priority: 80,
			content: `## Active project\n\nThe current conversation is bound to project "${project.name}" (kind=${project.kind}, slug=${project.slug}, id=${project.id}).${description}\n\nWrite files into this project's working directory rather than anywhere else, and read a file before editing it.${knowledge}${instructions}`,
		}
	} catch (err) {
		logger.warn('[chat] project context slot lookup failed', { err })
		return null
	}
}

/**
 * #35 — what a background command really is here.
 *
 * The CLI tells the model a backgrounded command "will be notified when it completes" and
 * to Read its output file for interim output. Neither holds in AgentStudio: the engine
 * closes the CLI after every turn, which ends every command it started, and the output file
 * is outside the run's workspace, where the containment guard refuses a Read. Without this
 * the model promises a user a dev server that is already gone. The user does see the output:
 * the command's card streams it while the turn runs.
 */
export const BACKGROUND_COMMAND_POLICY_LINES = [
	'- A Bash command run with run_in_background only runs until your reply ends: it is stopped when you finish, whatever its tool result says about notifying you later. Finish any work that needs it in this same reply, and never tell the user that something is still running after you have answered.',
	"- A background command's output file is outside your workspace, so Read cannot open it; the user sees that output live in the chat. If you need to read it yourself, have the command also write it into your workspace (for example `npm run dev 2>&1 | tee dev.log`) and Read that file.",
]

const ORCHESTRATOR_TOOL_POLICY = [
	'Tool usage policy:',
	'- If the user asks you to ask questions, gather preferences with options, or confirm choices before continuing, you MUST call the AskUserQuestion tool.',
	"- Do not only say you'll ask a question in plain text when AskUserQuestion is appropriate.",
	'- Use concise questions with clear option labels. The user can always pick "Other" and type their own answer, so never add an "Other" option yourself.',
	'- For AskUserQuestion: aim for ~3 options per question. Prefer asking more focused questions (split complex choices across multiple questions) rather than listing many options in one question. Set multiSelect when the choices are not mutually exclusive.',
	'- When the options are things to compare by eye (layouts, snippets, configurations), give each one an HTML preview. The user sees it in a sandboxed pane, so keep it self-contained with inline styles.',
	...BACKGROUND_COMMAND_POLICY_LINES,
	'',
	...DELEGATION_POLICY_LINES,
	'',
	...SUBAGENT_RESULT_POLICY_LINES,
].join('\n')

const AGENT_TOOL_POLICY = [
	'Tool usage policy:',
	'- You cannot ask the user questions directly (AskUserQuestion) in agent conversations.',
	'- If you need user input, summarize missing information and return control to orchestrator for follow-up.',
	...BACKGROUND_COMMAND_POLICY_LINES,
].join('\n')

/**
 * The tool-usage policy slot. Orchestrator agents get the AskUserQuestion-encouraging
 * variant; sub-agents get the variant that tells them they can't ask the user
 * directly. Priority 90 — high enough to be near the top, below identity and
 * project context.
 */
export function buildToolPolicySlot(isOrchestrator: boolean): ContextSlot {
	return {
		name: 'tool_policy',
		priority: 90,
		content: isOrchestrator ? ORCHESTRATOR_TOOL_POLICY : AGENT_TOOL_POLICY,
	}
}

/**
 * Split the assembled system-prompt slots into stable + volatile blocks for
 * OpenRouter's `cache_control` marker. The stable block carries the marker so
 * its bytes get cached across turns; the volatile block (memory recall, skill
 * summaries, companion-skill groups) is appended without a marker so it can
 * change every turn without invalidating the prefix.
 *
 * Returns an empty array when the assembled prompt is empty — caller should
 * skip injecting a system message in that case.
 */
export function buildCacheableSystemPromptBlocks(input: {
	renderedSlots: Array<{ name: string; content: string }>
	fallbackText: string
}): Array<{ type: 'text'; text: string; cacheControl?: { type: 'ephemeral' } }> {
	if (!input.fallbackText) return []

	const stableParts: string[] = []
	const volatileParts: string[] = []
	for (const { name, content } of input.renderedSlots) {
		if (VOLATILE_SLOT_NAMES.has(name)) volatileParts.push(content)
		else stableParts.push(content)
	}

	const blocks: Array<{ type: 'text'; text: string; cacheControl?: { type: 'ephemeral' } }> = []
	if (stableParts.length > 0) {
		blocks.push({
			type: 'text',
			text: stableParts.join('\n\n'),
			cacheControl: { type: 'ephemeral' },
		})
	}
	if (volatileParts.length > 0) {
		blocks.push({ type: 'text', text: volatileParts.join('\n\n') })
	}

	// Fallback: if the split produced nothing (e.g. all slots happened to be
	// volatile), keep the original behavior with cacheControl on the whole
	// prompt.
	if (blocks.length === 0) {
		blocks.push({
			type: 'text',
			text: input.fallbackText,
			cacheControl: { type: 'ephemeral' },
		})
	}

	return blocks
}
