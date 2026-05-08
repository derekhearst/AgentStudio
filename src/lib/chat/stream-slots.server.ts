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
	userQuery: string | undefined
	skillTopK: number
}): Promise<string | undefined> {
	const trimmed = input.userQuery?.trim() ?? ''
	const skillSummaries = trimmed.length > 0
		? await listRelevantSkillSummaries(trimmed, input.skillTopK)
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
 */
export async function buildBuiltinAgentPostureSlot(agent: AgentRow): Promise<ContextSlot | null> {
	if (!agent.builtinKey || agent.builtinKey === 'chat') return null
	const posture = await loadAgentIdentityContent(agent)
	return {
		name: `agent_${agent.builtinKey}`,
		priority: 95,
		content: posture,
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
		return {
			name: 'project_context',
			priority: 80,
			content: `## Active project\n\nThe current conversation is bound to project "${project.name}" (kind=${project.kind}, slug=${project.slug}, id=${project.id}).${description}\n\nWhen using create_artifact, prefer this project's id unless the user specifies otherwise. Use list_artifacts({projectId: "${project.id}"}) to see existing work in this project, and read_artifact before edit_artifact.`,
		}
	} catch (err) {
		logger.warn('[chat] project context slot lookup failed', { err })
		return null
	}
}

const ORCHESTRATOR_TOOL_POLICY = [
	'Tool usage policy:',
	'- If the user asks you to ask questions, gather preferences with options, or confirm choices before continuing, you MUST call the ask_user tool.',
	"- Do not only say you'll ask a question in plain text when ask_user is appropriate.",
	'- Use concise questions with clear option labels, and allow freeform input when the request is open-ended.',
	'- For ask_user: aim for ~3 prefilled answer options per question. Prefer asking more focused questions (split complex choices across multiple questions) rather than listing many options in one question.',
	'',
	'Tool surface (deferred loading):',
	'- A small core (web_search, ask_user, run_code, search_tools) is always available. The rest of the registry is gated behind `search_tools`.',
	'- When a task needs a capability you don\'t have loaded (file edits, image generation, source control, sub-agent delegation, etc.), call `search_tools(query)` once — it loads the matched tools so they appear in your tools array on the NEXT round.',
	"- Don't search speculatively. Match what the user actually asked for.",
	'- Loaded tools persist for the rest of the conversation, so a single search per capability is enough.',
].join('\n')

const AGENT_TOOL_POLICY = [
	'Tool usage policy:',
	'- You cannot call ask_user directly in agent conversations.',
	'- If you need user input, summarize missing information and return control to orchestrator for follow-up.',
	'',
	'Tool surface (deferred loading):',
	'- A small core (web_search, run_code, search_tools) is always available. Use `search_tools(query)` to load additional tools by free-text query — matched tools become callable on the NEXT round and stay loaded for the rest of the conversation.',
].join('\n')

/**
 * The tool-usage policy slot. Orchestrator agents get the ask_user-encouraging
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
