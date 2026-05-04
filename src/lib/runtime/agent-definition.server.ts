import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import type { agents } from '$lib/agents/agents.schema'
import { skills } from '$lib/skills/skills.schema'
import { getToolDefinitions } from '$lib/tools/tools.server'
import { listSkillSummaries } from '$lib/skills/skills.server'
import { recallForUser, renderMemoryContext } from '$lib/memory/memory.server'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { assembleSystemPrompt, type ContextSlot } from '$lib/context/slots.server'
import { expandFragments } from '$lib/agents/fragment-expand'
import type { ToolDefinition } from './types'

/**
 * Wave 2 #10 phase 2 — formal AgentDefinition builder for non-chat callers.
 *
 * The chat stream's prompt assembly is too conversation-specific (mode posture, conversation
 * mode anchor, per-conversation slot overrides, in-flight context_stats event) to share. But
 * sub-agents, automations, and the task runner all build the SAME shape: agent identity +
 * role + a generic tool policy + skill summaries + (optional) memory recall. This module
 * pulls that pattern into one place so they stop drifting.
 *
 * Returns a fully-resolved object the caller hands directly to `runChatLoop`:
 *   - `systemPrompt` (already slot-assembled — caller doesn't need to know about slots)
 *   - `tools` (filtered for the non-chat surface: never ask_user; respects allowedTools)
 *   - `persistentKey` / `worktree` (from agent.config.workspace)
 *
 * The chat stream stays inline because its slot pipeline is fundamentally different.
 */

export type AgentRecord = typeof agents.$inferSelect

export type BuildAgentDefinitionInput = {
	agent: AgentRecord
	userId: string
	/**
	 * Free-form text describing what the run is for — used for memory recall scoring. Pass the
	 * task description, automation prompt, or sub-agent task. Skip recall when empty.
	 */
	intent?: string
	/**
	 * The agent collaboration policy text — varies by caller. Sub-agents say "you cannot
	 * ask_user, return a handoff"; automations say "no human in the loop, summarize what you
	 * did"; tasks say similar. Caller picks the right one.
	 */
	toolPolicy: string
	/** Override the per-call memory topK (defaults to settings.memoryConfig.topK ?? 5). */
	memoryTopK?: number
}

export type AgentDefinition = {
	systemPrompt: string
	tools: ToolDefinition[]
	persistentKey: string | null
	worktree: {
		repoPath: string
		baseBranch?: string
		deleteBranchOnCleanup?: boolean
	} | null
	/** Convenience: which slots actually got included after assembly. */
	includedSlots: string[]
}

/**
 * Build the agent's system prompt + tool surface + workspace context for a non-chat run.
 *
 * Slot priorities mirror the chat stream:
 *   - identity (100): agent's systemPrompt
 *   - role (95): "Your role: …"
 *   - tool_policy (90): the caller-supplied policy text
 *   - skills (70, truncate-end): summary list of all enabled skills
 *   - memory (60, truncate-end): recalled memory matching `intent` (if provided)
 */
export async function buildAgentDefinition(input: BuildAgentDefinitionInput): Promise<AgentDefinition> {
	const config = (input.agent.config ?? null) as
		| {
				allowedTools?: string[]
				workspace?: {
					mode?: string
					key?: string
					repoPath?: string
					baseBranch?: string
					deleteBranchOnCleanup?: boolean
				}
		  }
		| null

	const persistentKey =
		config?.workspace?.mode === 'persistent' &&
		typeof config.workspace.key === 'string' &&
		config.workspace.key.length > 0
			? config.workspace.key
			: null
	const worktree =
		config?.workspace?.mode === 'worktree' &&
		typeof config.workspace.repoPath === 'string' &&
		config.workspace.repoPath.length > 0
			? {
					repoPath: config.workspace.repoPath,
					baseBranch: config.workspace.baseBranch,
					deleteBranchOnCleanup: config.workspace.deleteBranchOnCleanup,
				}
			: null

	// Wave 5 #22 phase 2 — when the agent has an `identitySkillId`, prefer the skill's
	// content over the legacy `systemPrompt` column. Operators edit the skill at /skills/[id]
	// and the next run picks up the change without a deploy. Falls back to systemPrompt when
	// the skill is missing/disabled (defense in depth — a misconfigured skill row never
	// breaks an agent's run).
	const identityContent = await loadAgentIdentity(input.agent)

	const slots: ContextSlot[] = [
		{ name: 'identity', priority: 100, content: identityContent },
		{ name: 'role', priority: 95, content: `Your role: ${input.agent.role}` },
		{ name: 'tool_policy', priority: 90, content: input.toolPolicy },
	]

	const skillSummaries = await listSkillSummaries()
	if (skillSummaries.length > 0) {
		const text = skillSummaries
			.map((s) => {
				const fileNames = s.files.map((f) => f.name).join(', ')
				return `- ${s.name}: ${s.description}${fileNames ? ` [files: ${fileNames}]` : ''}`
			})
			.join('\n')
		slots.push({
			name: 'skills',
			priority: 70,
			content: `Available skills (use read_skill to load):\n${text}`,
			truncationStrategy: 'truncate-end',
		})
	}

	if (input.intent && input.intent.trim().length > 0) {
		try {
			const settings = await getOrCreateSettings(input.userId)
			const memoryConfig = (settings.memoryConfig ?? null) as {
				enabled?: boolean
				topK?: number
				useRerank?: boolean
				rerankModel?: string
			} | null
			if (memoryConfig?.enabled !== false) {
				const recalled = await recallForUser(input.userId, input.intent.trim(), {
					topK: input.memoryTopK ?? memoryConfig?.topK ?? 5,
					useRerank: memoryConfig?.useRerank ?? false,
					rerankModel: memoryConfig?.rerankModel,
				})
				const memoryBlock = renderMemoryContext(recalled)
				if (memoryBlock) {
					slots.push({
						name: 'memory',
						priority: 60,
						content: memoryBlock,
						truncationStrategy: 'truncate-end',
					})
				}
			}
		} catch (err) {
			console.warn('[runtime/agent-definition] memory recall failed', err)
		}
	}

	const assembled = assembleSystemPrompt(slots)

	// Tool surface: never expose ask_user (the loop's `isOrchestrator: false` would refuse it
	// anyway, but trimming up front keeps the prompt slim). Respect allowedTools when set.
	const allTools = getToolDefinitions().filter((t) => t.function.name !== 'ask_user')
	const tools =
		Array.isArray(config?.allowedTools) && config.allowedTools.length > 0
			? allTools.filter((t) => config.allowedTools!.includes(t.function.name))
			: allTools

	return {
		systemPrompt: assembled.systemPrompt,
		tools,
		persistentKey,
		worktree,
		includedSlots: assembled.includedSlots,
	}
}

/**
 * Wave 5 #22 phase 2 — load the agent's identity content from the linked skill (when
 * `identitySkillId` is set + the skill is enabled), falling back to the legacy
 * `systemPrompt` column otherwise. Always returns a non-empty string.
 */
async function loadAgentIdentity(agent: AgentRecord): Promise<string> {
	let raw = agent.systemPrompt
	if (agent.identitySkillId) {
		try {
			const [skill] = await db
				.select({ content: skills.content, enabled: skills.enabled })
				.from(skills)
				.where(eq(skills.id, agent.identitySkillId))
				.limit(1)
			if (skill && skill.enabled && skill.content.trim().length > 0) {
				raw = skill.content
			}
		} catch (err) {
			console.warn('[runtime] failed to load agent identity skill, using systemPrompt fallback', err)
		}
	}
	// Wave 5 #22 phase 5 — expand `@import skill-name` fragments. Best-effort: a lookup
	// failure leaves a `<!-- @import:missing ... -->` marker in the assembled prompt rather
	// than throwing.
	try {
		return await expandFragments(raw, lookupFragmentByName)
	} catch (err) {
		console.warn('[runtime] fragment expansion failed, using raw content', err)
		return raw
	}
}

async function lookupFragmentByName(name: string): Promise<string | null> {
	try {
		const [row] = await db
			.select({ content: skills.content, enabled: skills.enabled })
			.from(skills)
			.where(eq(skills.name, name))
			.limit(1)
		if (!row || !row.enabled) return null
		return row.content
	} catch {
		return null
	}
}
