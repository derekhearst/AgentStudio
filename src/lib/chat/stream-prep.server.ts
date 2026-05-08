/**
 * Pure-ish helpers extracted from the chat stream POST handler.
 *
 * Each helper is independently testable: feed it the raw inputs (settings row,
 * skill summaries) and it returns the prepared value the handler used to assemble
 * inline. No dependencies on the request lifecycle — the orchestrator stays
 * the only caller.
 */

import { listRelevantSkillSummaries, listSkillSummaries } from '$lib/skills/skills.server'
import { recallForUser, renderMemoryContext } from '$lib/memory/memory.server'
import type { ContextSlot } from '$lib/context/slots.server'
import { logger } from '$lib/observability/logger'
import type { getSettings } from '$lib/settings'

type AppSettings = Awaited<ReturnType<typeof getSettings>>

// Slot names whose content recomputes per query (skill top-K relevance, companion-skill
// groups, memory recall) — they're appended after the cache_control boundary so the
// stable prefix doesn't cache-miss every turn.
const VOLATILE_SLOT_NAMES = new Set(['memory', 'skills', 'companion_skills'])

/**
 * Build the set of tool names that require operator approval before execution.
 *
 * Sources:
 *   1. Per-user `settings.toolConfig.approvalRequiredTools` (or the legacy
 *      `'*'` wildcard derived from `approvalMode === 'confirm'`).
 *   2. The MANDATORY_APPROVAL_TOOLS allowlist — destructive source-control
 *      operations (push_branch, create_pull_request) that always require
 *      approval regardless of user settings.
 *
 * Also returns whether programmatic tool calling is enabled — surfaced from
 * the same toolConfig blob so callers don't reach into the JSONB twice.
 */
export async function buildApprovalRequiredSet(settings: AppSettings): Promise<{
	approvalRequiredTools: Set<string>
	programmaticToolCallingEnabled: boolean
}> {
	const toolConfig = settings.toolConfig as
		| {
				approvalRequiredTools?: string[]
				approvalMode?: string
				programmaticToolCallingEnabled?: boolean
		  }
		| undefined
	const approvalRequiredTools = new Set(
		toolConfig?.approvalRequiredTools ?? (toolConfig?.approvalMode === 'confirm' ? ['*'] : []),
	)
	const programmaticToolCallingEnabled = toolConfig?.programmaticToolCallingEnabled === true

	// Wave 5 #19 phase 3 finish — destructive source-control tools always require
	// operator approval. Refused outright in non-interactive runs at the tool
	// execution layer.
	const { MANDATORY_APPROVAL_TOOLS } = await import('$lib/tools/tools')
	for (const toolName of MANDATORY_APPROVAL_TOOLS) approvalRequiredTools.add(toolName)

	return { approvalRequiredTools, programmaticToolCallingEnabled }
}

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
