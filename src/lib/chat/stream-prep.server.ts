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

import { compactMessages, generateTitle, shouldCompact } from '$lib/chat/chat.server'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { insertMessageWithSequence } from '$lib/chat/insert-message.server'
import { and, desc, sql } from 'drizzle-orm'
import { trimHistoricalToolResults } from '$lib/chat/chat'
import { getToolDefinitions } from '$lib/tools/tools.server'
import { filterToolsByAgentPolicy, type resolveAgentToolPolicy } from '$lib/chat/agent-switch.server'
import { checkBudgetLimits, recordBudgetAlert } from '$lib/costs/budget.server'
import { db } from '$lib/db.server'
import { eq } from 'drizzle-orm'
import { logger } from '$lib/observability/logger'
import type { LlmMessage } from '$lib/llm/chat.server'
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

export type CompactionStats = {
	messagesBefore: number
	messagesAfter: number
	originalTokens: number
	compactedTokens: number
	summaryTokens: number
	compactionModel: string
}

/**
 * Run conversation compaction if the message list has grown past the model's
 * context window. Mutates `llmMessages` in place when compaction succeeds and
 * returns the stats summary the SSE handler emits to the client. `tokensBefore`
 * comes from the shouldCompact probe so the SSE compaction event can show the
 * pre-compaction token estimate even when no compaction ran (degenerate cases
 * like an empty history that produced no summary).
 */
export async function maybeCompactConversation(input: {
	llmMessages: LlmMessage[]
	model: string
	userId: string
}): Promise<{ didCompact: boolean; stats: CompactionStats | null; tokensBefore: number }> {
	const compactionCheck = await shouldCompact(input.llmMessages, input.model, input.userId)
	const tokensBefore = compactionCheck.tokenEstimate
	if (!compactionCheck.needed) {
		return { didCompact: false, stats: null, tokensBefore }
	}

	const messagesBefore = input.llmMessages.length
	const result = await compactMessages(input.llmMessages, input.userId, input.model)
	if (!result.summary) {
		return { didCompact: false, stats: null, tokensBefore }
	}

	input.llmMessages.length = 0
	input.llmMessages.push(...result.compacted)
	return {
		didCompact: true,
		tokensBefore,
		stats: {
			messagesBefore,
			messagesAfter: result.compacted.length,
			originalTokens: result.originalTokens,
			compactedTokens: result.compactedTokens,
			summaryTokens: result.summaryTokens,
			compactionModel: result.compactionModel,
		},
	}
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
export async function resolveParentMessage(input: {
	conversationId: string
	body: {
		regenerate?: boolean
		content?: string
		attachments?: Array<{ id: string; filename: string; mimeType: string; size: number; url: string }>
	}
	model: string
}): Promise<
	| { ok: true; parentMessageId: string | null }
	| { ok: false; error: string }
> {
	if (!input.body.regenerate) {
		if (!input.body.content || input.body.content.trim().length === 0) {
			return { ok: false, error: 'content is required when regenerate=false' }
		}
		const createdUser = await insertMessageWithSequence({
			conversationId: input.conversationId,
			role: 'user',
			content: input.body.content.trim(),
			model: input.model,
			metadata: {},
			toolCalls: [],
			attachments: input.body.attachments ?? [],
		})
		return { ok: true, parentMessageId: createdUser.id }
	}

	const [lastUser] = await db
		.select()
		.from(messages)
		.where(and(eq(messages.conversationId, input.conversationId), eq(messages.role, 'user')))
		.orderBy(desc(messages.sequence))
		.limit(1)
	return { ok: true, parentMessageId: lastUser?.id ?? null }
}

export type AssistantPersistInput = {
	conversationId: string
	parentMessageId: string | null
	model: string
	content: string
	promptTokens: number
	completionTokens: number
	ttftMs: number | null
	totalMs: number
	tokensPerSec: number | null
	cost: string
	metadata: Record<string, unknown>
	toolCalls: Array<Record<string, unknown>>
	runId: string
	conversationTotals: {
		previousTokens: number
		previousCost: string
	}
}

/**
 * Persist the final assistant message + bump conversation totals in a single
 * transaction. Detect-and-merge: if `savePartialAssistant` wrote a partial row
 * for this run (network-blip recovery path), update it in place instead of
 * inserting a second assistant row for the same logical turn — matched by
 * runId in metadata + the `partial` flag.
 *
 * Wrapping both the message write and the totals update in one transaction
 * means a crash between them can't leave the row + totals desynced.
 */
export async function persistAssistantMessage(input: AssistantPersistInput) {
	return db.transaction(async (tx) => {
		const [existingPartial] = await tx
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, input.conversationId),
					eq(messages.role, 'assistant'),
					sql`${messages.metadata}->>'runId' = ${input.runId}`,
					sql`${messages.metadata}->>'partial' = 'true'`,
				),
			)
			.limit(1)

		const written = existingPartial
			? (
					await tx
						.update(messages)
						.set({
							content: input.content,
							model: input.model,
							parentMessageId: input.parentMessageId,
							tokensIn: input.promptTokens,
							tokensOut: input.completionTokens,
							ttftMs: input.ttftMs,
							totalMs: input.totalMs,
							tokensPerSec: input.tokensPerSec,
							cost: input.cost,
							metadata: input.metadata,
							toolCalls: input.toolCalls,
						})
						.where(eq(messages.id, existingPartial.id))
						.returning()
				)[0]
			: await insertMessageWithSequence(
					{
						conversationId: input.conversationId,
						role: 'assistant',
						content: input.content,
						model: input.model,
						parentMessageId: input.parentMessageId,
						tokensIn: input.promptTokens,
						tokensOut: input.completionTokens,
						ttftMs: input.ttftMs,
						totalMs: input.totalMs,
						tokensPerSec: input.tokensPerSec,
						cost: input.cost,
						metadata: input.metadata,
						toolCalls: input.toolCalls,
					},
					tx,
				)

		await tx
			.update(conversations)
			.set({
				model: input.model,
				totalTokens:
					input.conversationTotals.previousTokens + input.promptTokens + input.completionTokens,
				totalCost: String(
					parseFloat(input.conversationTotals.previousCost) + parseFloat(input.cost),
				),
				updatedAt: new Date(),
			})
			.where(eq(conversations.id, input.conversationId))

		return written
	})
}

/**
 * Fire-and-forget title generation for the first exchange of a conversation.
 * Sends the user message + assistant response to the title-gen model, then
 * writes the result back to `conversations.title`. Title-gen failures are
 * silently swallowed — the conversation keeps its default title and the
 * normal chat flow is unaffected.
 */
export function maybeGenerateTitle(input: {
	isFirstExchange: boolean
	userContent: string
	assistantContent: string
	conversationId: string
}): void {
	if (!input.isFirstExchange || !input.userContent.trim()) return
	void (async () => {
		try {
			const title = await generateTitle([
				{ role: 'user', content: input.userContent.trim() },
				{ role: 'assistant', content: input.assistantContent },
			])
			await db.update(conversations).set({ title }).where(eq(conversations.id, input.conversationId))
		} catch {
			// Non-critical — title stays as default.
		}
	})()
}

/**
 * Enqueue the memory-mining job for a conversation that just finished, when
 * the user has auto-mining enabled. DedupeKey collapses concurrent finishes
 * for the same conversation into one job; failures are visible in
 * /settings/jobs rather than silently swallowed.
 */
export function enqueueMemoryMineJob(input: {
	settings: AppSettings
	conversationId: string
	userId: string
	runId: string
}): void {
	const autoMine = (input.settings.memoryConfig as { autoMine?: boolean } | null)?.autoMine !== false
	if (!autoMine) return
	void (async () => {
		try {
			const { enqueueJob } = await import('$lib/jobs/jobs.server')
			await enqueueJob({
				type: 'memory_mine',
				queue: 'default',
				priority: 50, // background work — outranked by user-initiated jobs
				dedupeKey: `mine:${input.conversationId}`,
				payload: { conversationId: input.conversationId },
				userId: input.userId,
				runId: input.runId,
				sessionId: input.conversationId,
			})
		} catch (err) {
			logger.warn('[memory] enqueue mine job failed', { err })
		}
	})()
}

/**
 * Enqueue the evaluator pass for a finished run. Triggered when the run row
 * had `evalRequired = true`. The verdict shows up in the run viewer's
 * Evaluations panel asynchronously when the worker finishes (no SSE event).
 */
export function enqueueEvaluationJob(input: {
	runId: string
	userId: string
	conversationId: string
	userContent: string | undefined
	assistantContent: string
	toolCalls: Array<Record<string, unknown>>
}): void {
	void (async () => {
		try {
			const { enqueueJob } = await import('$lib/jobs/jobs.server')
			const toolSummary = input.toolCalls.length > 0
				? input.toolCalls.map((c) => (c as { name?: string }).name).filter(Boolean).join(', ')
				: undefined
			await enqueueJob({
				type: 'evaluation_run',
				queue: 'default',
				priority: 75, // higher than memory_mine (50), lower than user-initiated (100+)
				dedupeKey: `eval:${input.runId}`,
				payload: {
					runId: input.runId,
					userId: input.userId,
					conversationId: input.conversationId,
					taskDescription: input.userContent?.trim() ?? '(no user message)',
					generatorOutput: input.assistantContent,
					toolSummary,
				},
				userId: input.userId,
				runId: input.runId,
				sessionId: input.conversationId,
			})
		} catch (err) {
			logger.warn('[evaluations] enqueue evaluation_run job failed', { err })
		}
	})()
}

/**
 * Detect whether the trimmed message list contains a PDF attachment (file
 * content block) and return the OpenRouter `chatPlugins` config that engages
 * the file-parser. We default to the `pdf-text` engine — a good middle ground
 * for text-only PDFs without paying the OCR cost. Returns `undefined` when
 * no PDFs are present so the caller can omit the plugin field entirely.
 */
export function detectPdfPluginConfig(
	messages: LlmMessage[],
): Array<{ id: 'file-parser'; pdf: { engine: 'pdf-text' } }> | undefined {
	const hasPdfAttachment = messages.some(
		(m) =>
			Array.isArray(m.content) &&
			m.content.some((b) => typeof b === 'object' && b !== null && 'type' in b && b.type === 'file'),
	)
	return hasPdfAttachment ? [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }] : undefined
}

/**
 * Wrap `trimHistoricalToolResults` with the per-user `preserveToolResults`
 * config. Tools listed there have their results passed through unmodified;
 * everything else is subject to the default trimming rules. Returns the
 * trimmed list plus the appliedEdits the SSE handler emits to the client.
 */
export function trimToolResultsForRun(input: {
	messages: LlmMessage[]
	settings: AppSettings
}): ReturnType<typeof trimHistoricalToolResults> {
	const preserveToolResultsRaw = (input.settings.contextConfig as { preserveToolResults?: string[] } | null)
		?.preserveToolResults
	const preserveToolNames =
		Array.isArray(preserveToolResultsRaw) && preserveToolResultsRaw.length > 0
			? new Set(preserveToolResultsRaw)
			: undefined
	return trimHistoricalToolResults(input.messages, { preserveToolNames })
}

export type ToolComputerConfig = {
	scopedAgentTools: string[] | null
	isOrchestrator: boolean
	programmaticToolCallingEnabled: boolean
	agentToolPolicy: ReturnType<typeof resolveAgentToolPolicy>
	dreamingOnlyTools: ReadonlySet<string>
}

/**
 * Factory for the per-run `computeTools()` closure. Owns the mutable
 * `loadedSearchableTools` set so the runtime can extend the loaded surface
 * via `search_tools(query)` between rounds.
 *
 * Resolution order on each compute:
 *   1. scopedAgentTools (agent.config.allowedTools) — explicit fixed surface,
 *      tier filter off.
 *   2. Default — only `disclosure: 'always'` tools loaded; everything else is
 *      searchable via search_tools. Once invoked, the runtime adds matched
 *      names to loadedSearchableTools and the next compute picks them up.
 *
 * `ask_user` is stripped for non-orchestrator agents (they return control
 * instead of asking the user). `run_code` is stripped when programmatic tool
 * calling is disabled. Built-in Research/Plan agents apply the
 * agentToolPolicy allow-list so newly-added tools fail closed.
 */
export function createToolComputer(config: ToolComputerConfig): {
	loadedSearchableTools: Set<string>
	computeTools: () => ReturnType<typeof getToolDefinitions>
} {
	const loadedSearchableTools = new Set<string>()

	const computeTools = () => {
		const all = getToolDefinitions(undefined, {
			tierFilter: !config.scopedAgentTools,
			loadedSearchable: loadedSearchableTools,
		})
		const askUserFiltered = all.filter(
			(tool) => (config.isOrchestrator ? true : tool.function.name !== 'ask_user'),
		)
		const ptcFiltered = config.programmaticToolCallingEnabled
			? askUserFiltered
			: askUserFiltered.filter((tool) => tool.function.name !== 'run_code')
		let assembled: typeof ptcFiltered
		if (config.scopedAgentTools) {
			const allowed = config.scopedAgentTools
			assembled = ptcFiltered.filter((tool) => allowed.includes(tool.function.name))
		} else {
			assembled = ptcFiltered.filter((tool) => !config.dreamingOnlyTools.has(tool.function.name))
		}
		return filterToolsByAgentPolicy(assembled, config.agentToolPolicy)
	}

	return { loadedSearchableTools, computeTools }
}

type HistoryRow = {
	role: string
	content: string
	attachments: Array<{ mimeType: string; url: string; filename?: string | null }> | null
}

/**
 * Convert chat history rows from the DB into the LlmMessage[] shape the
 * runtime feeds to OpenRouter. Multimodal attachments (images, PDFs, videos)
 * are unpacked into per-type content blocks; text-only messages stay as a
 * plain string. Tool/system rows that aren't user/assistant/system are filtered
 * out — the chat history table can hold tool messages but the LLM input list
 * doesn't carry them through (they're rebuilt from tool_calls metadata).
 */
export function buildLlmMessagesFromHistory(historyRows: HistoryRow[]): LlmMessage[] {
	return historyRows
		.filter((row) => row.role === 'system' || row.role === 'user' || row.role === 'assistant')
		.map((row) => {
			const attachments = row.attachments ?? []
			const imageAttachments = attachments.filter((a) => a.mimeType.startsWith('image/'))
			const pdfAttachments = attachments.filter((a) => a.mimeType === 'application/pdf')
			const videoAttachments = attachments.filter((a) => a.mimeType.startsWith('video/'))
			const hasMultimodal =
				row.role === 'user' &&
				(imageAttachments.length > 0 || pdfAttachments.length > 0 || videoAttachments.length > 0)
			if (hasMultimodal) {
				return {
					role: row.role as 'user',
					content: [
						{ type: 'text' as const, text: row.content },
						...imageAttachments.map((a) => ({
							type: 'image_url' as const,
							image_url: { url: a.url },
						})),
						...pdfAttachments.map((a) => ({
							type: 'file' as const,
							file: { filename: a.filename || 'document.pdf', file_data: a.url },
						})),
						...videoAttachments.map((a) => ({
							type: 'video_url' as const,
							video_url: { url: a.url },
						})),
					],
				} as LlmMessage
			}
			return { role: row.role as 'user' | 'assistant' | 'system', content: row.content }
		})
}

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
