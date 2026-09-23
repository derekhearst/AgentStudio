/**
 * Pure-ish helpers extracted from the chat stream POST handler.
 *
 * Each helper is independently testable: feed it the raw inputs (settings row,
 * skill summaries) and it returns the prepared value the handler used to assemble
 * inline. No dependencies on the request lifecycle — the orchestrator stays
 * the only caller.
 *
 * Slot builders (identity, memory recall, project context, tool policy, etc.) were
 * extracted to `stream-slots.server.ts` and are re-exported below so existing imports
 * from this module keep working.
 */

import { checkBudgetLimits, recordBudgetAlert } from '$lib/costs/budget.server'
import { logger } from '$lib/observability/logger'
import type { getSettings } from '$lib/settings'

type AppSettings = Awaited<ReturnType<typeof getSettings>>

// Re-exported from stream-slots.server.ts so callers don't need to update imports.
export {
	buildSkillSummariesText,
	resolveSkillTopK,
	buildMemoryRecallSlot,
	buildBuiltinAgentPostureSlot,
	buildIdentitySlot,
	buildProjectContextSlot,
	buildToolPolicySlot,
	buildCacheableSystemPromptBlocks,
} from './stream-slots.server'

/**
 * Build the set of tool names that require operator approval before execution.
 *
 * Sources:
 *   1. Per-user `settings.toolConfig.approvalRequiredTools` (or the legacy
 *      `'*'` wildcard derived from `approvalMode === 'confirm'`).
 *   2. The MANDATORY_APPROVAL_TOOLS allowlist — destructive source-control
 *      operations (push_branch, create_pull_request) that always require
 *      approval regardless of user settings.
 */
export async function buildApprovalRequiredSet(settings: AppSettings): Promise<{
	approvalRequiredTools: Set<string>
}> {
	const toolConfig = settings.toolConfig as
		| {
				approvalRequiredTools?: string[]
				approvalMode?: string
		  }
		| undefined
	const approvalRequiredTools = new Set(
		toolConfig?.approvalRequiredTools ?? (toolConfig?.approvalMode === 'confirm' ? ['*'] : []),
	)

	// Wave 5 #19 phase 3 finish — destructive source-control tools always require
	// operator approval. Refused outright in non-interactive runs at the tool
	// execution layer.
	const { MANDATORY_APPROVAL_TOOLS } = await import('$lib/tools/tools')
	for (const toolName of MANDATORY_APPROVAL_TOOLS) approvalRequiredTools.add(toolName)

	return { approvalRequiredTools }
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type ResolvedModelConfig = {
	routedModel: string
	reasoningEffort: ReasoningEffort
	reasoningConfig: { enabled: boolean; exclude: boolean; effort: ReasoningEffort } | undefined
	modelSelection: {
		source: 'user' | 'settingsDefault'
		reason: string
	}
}

/**
 * Resolve the effective model + reasoning config for this run from the request
 * body and the user's settings. The routed model defaults to the per-user
 * `defaultModel` when the body omits one. Reasoning effort defaults to 'none',
 * which short-circuits the reasoning config to undefined so we don't ask
 * non-reasoning models to spend tokens on it.
 */
export function resolveModelConfig(input: {
	body: { model?: string; reasoningEffort?: ReasoningEffort }
	settings: AppSettings
}): ResolvedModelConfig {
	const selectedModel = input.body.model?.trim()
	const routedModel =
		selectedModel && selectedModel.length > 0 ? selectedModel : input.settings.defaultModel
	const reasoningEffort = input.body.reasoningEffort ?? 'none'
	const reasoningConfig =
		reasoningEffort === 'none' ? undefined : { enabled: true, exclude: false, effort: reasoningEffort }
	return {
		routedModel,
		reasoningEffort,
		reasoningConfig,
		modelSelection: {
			source: selectedModel ? 'user' : 'settingsDefault',
			reason: selectedModel ? 'User-selected model' : 'Default model from settings',
		},
	}
}

/**
 * Resolve the parent message id for the assistant turn and (when not
 * regenerating) insert the user's message into the conversation.
 *
 * - On a fresh user message: inserts the row and returns its id as parent.
 * - On regenerate: finds the most recent user message in the conversation and
 *   uses its id as parent.
 *
 * Returns `{ parentMessageId: null, error }` for the early-return case where
 * the body lacks content for a non-regenerate request.
 */
// Re-exported from stream-persistence.server.ts so callers don't need to update imports.
export {
	resolveParentMessage,
	persistAssistantMessage,
	maybeGenerateTitle,
	enqueueMemoryMineJob,
	enqueueEvaluationJob,
	type AssistantPersistInput,
} from './stream-persistence.server'

export type BudgetEnforcementResult =
	| { blocked: false }
	| {
			blocked: true
			payload: {
				error: 'budget_exceeded'
				message: string
				limitId: string
			}
	  }

/**
 * Apply per-user budget caps before opening a chat run. Records warning alerts
 * for any limits the user is approaching, and when a `block` limit is hit:
 *
 *   1. Awaits a budget_alerts insert so callers querying immediately after the
 *      402 see the row (no fire-and-forget race).
 *   2. Fires a `policy_override_request` into the review inbox so an operator
 *      can decide whether to lift the cap or hold it. Dedup-keyed by limitId
 *      + userId so repeated denials collapse into one open item.
 *   3. Returns the JSON payload the caller should send with status 402.
 *
 * Phase 3 of #5: this runs BEFORE creating the chat_runs row so a blocked
 * request doesn't leave an orphan run.
 */
export async function enforceBudgetGuard(input: {
	userId: string
	agentId: string | null
	conversationId: string
}): Promise<BudgetEnforcementResult> {
	const budgetCheck = await checkBudgetLimits({
		userId: input.userId,
		agentId: input.agentId,
	})

	for (const w of budgetCheck.warnings) {
		try {
			await recordBudgetAlert({ limit: w.limit, triggerType: 'warn', spendUsd: w.spendUsd })
		} catch (err) {
			logger.warn('[budget] warn alert insert failed', { err })
		}
	}

	if (budgetCheck.allowed || !budgetCheck.blockedBy) {
		return { blocked: false }
	}

	const blockedBy = budgetCheck.blockedBy

	// Await the alert write so callers querying budget_alerts immediately after the
	// 402 response see the row (no fire-and-forget race).
	try {
		await recordBudgetAlert({
			limit: blockedBy,
			triggerType: 'block',
			spendUsd: parseFloat(blockedBy.limitUsd),
		})
	} catch (err) {
		logger.warn('[budget] block alert insert failed', { err })
	}

	// Wave 5 #20 — surface the block as a policy_override_request in the review
	// inbox. Best-effort dynamic import keeps the chat-stream path free of an
	// observability cycle. DedupeKey collapses repeated denials into one open item.
	void (async () => {
		try {
			const { openReviewItem } = await import('$lib/observability/review.server')
			await openReviewItem({
				type: 'policy_override_request',
				severity: 'warning',
				summary: `Budget block: ${blockedBy.scope} ${blockedBy.period} limit of $${blockedBy.limitUsd} for user ${input.userId.slice(0, 8)}`,
				payload: {
					kind: 'budget',
					limitId: blockedBy.id,
					scope: blockedBy.scope,
					scopeId: blockedBy.scopeId,
					period: blockedBy.period,
					limitUsd: blockedBy.limitUsd,
					userId: input.userId,
					conversationId: input.conversationId,
				},
				sessionId: input.conversationId,
				dedupeKey: `budget:${blockedBy.id}:${input.userId}`,
			})
		} catch (err) {
			logger.warn('[budget] policy_override_request open failed', { err })
		}
	})()

	return {
		blocked: true,
		payload: {
			error: 'budget_exceeded',
			message: `Budget cap exceeded: ${blockedBy.scope} ${blockedBy.period} limit of $${blockedBy.limitUsd}`,
			limitId: blockedBy.id,
		},
	}
}

export type AgentWorkspaceConfig = {
	/** When the agent has an `allowedTools` whitelist, the runtime restricts the tool surface. */
	scopedAgentTools: string[] | null
	/** Phase 2 of #7: opt-in persistent workspace per agent. */
	persistentKey: string | null
	/** Phase 4 of #7: opt-in git-worktree workspace per agent. */
	worktreeConfig: {
		repoPath: string
		baseBranch?: string
		deleteBranchOnCleanup?: boolean
	} | null
}

/**
 * Read the optional workspace + tool policy fields off `agent.config`. Returns
 * a tuple of nullable values rather than throwing — most agents have none of
 * these set and the runtime treats them as "not configured".
 */
export function extractAgentWorkspaceConfig(agentConfig: unknown): AgentWorkspaceConfig {
	const config = agentConfig as
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

	const scopedAgentTools =
		Array.isArray(config?.allowedTools) && config.allowedTools.length > 0 ? config.allowedTools : null

	const persistentKey =
		config?.workspace?.mode === 'persistent' &&
		typeof config.workspace.key === 'string' &&
		config.workspace.key.length > 0
			? config.workspace.key
			: null

	const worktreeConfig =
		config?.workspace?.mode === 'worktree' &&
		typeof config.workspace.repoPath === 'string' &&
		config.workspace.repoPath.length > 0
			? {
					repoPath: config.workspace.repoPath,
					baseBranch: config.workspace.baseBranch,
					deleteBranchOnCleanup: config.workspace.deleteBranchOnCleanup,
				}
			: null

	return { scopedAgentTools, persistentKey, worktreeConfig }
}
