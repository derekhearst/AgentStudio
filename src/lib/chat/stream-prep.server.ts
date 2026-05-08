/**
 * Pure-ish helpers extracted from the chat stream POST handler.
 *
 * Each helper is independently testable: feed it the raw inputs (settings row,
 * skill summaries) and it returns the prepared value the handler used to assemble
 * inline. No dependencies on the request lifecycle — the orchestrator stays
 * the only caller.
 */

import { listRelevantSkillSummaries, listSkillSummaries } from '$lib/skills/skills.server'
import type { getSettings } from '$lib/settings'

type AppSettings = Awaited<ReturnType<typeof getSettings>>

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
