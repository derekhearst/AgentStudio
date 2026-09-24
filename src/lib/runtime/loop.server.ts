import { streamChat } from '$lib/llm/chat.server'
import { setRunRound } from '$lib/runs/blocks.server'
import { emitHook } from '$lib/hooks'
import type { LoopMessage, RunChatLoopInput, RunChatLoopResult } from './types'
import { extractReasoningFragment, type ReasoningDetail } from './reasoning-extractor'
import { closeRunTrace, markLastToolForCaching, openRunTrace } from './trace-helpers'
import { dispatchToolCall, type DispatchContext } from './tool-handlers.server'
import { offeredToolNames } from './offered-tools'

/**
 * Wave 2 #10 phase 1 — extracted chat loop.
 *
 * The pre-engine loop: OpenRouter's streaming chat API, our registry tools, serial tool
 * execution. Interactive chat moved to the Agent SDK engine (`$lib/engine`); what still runs
 * here is unattended — automations with an agent attached, a monitor's start_conversation,
 * CI fix runs — each on a detached session, with the short tool list in `./detached-tools`.
 *
 * The caller does:
 *   1. Build the system prompt + initial messages (`buildAgentDefinition`).
 *   2. Build the session (`createDetachedSession`).
 *   3. Call `runChatLoop`.
 *   4. Persist the resulting message + cost + activity rollups.
 */

export async function runChatLoop(input: RunChatLoopInput): Promise<RunChatLoopResult> {
	try {
		return await runChatLoopRounds(input)
	} catch (err) {
		// The trace ends the way the run did; the caller still records the failure itself.
		closeRunTrace(input.session.runId, 'failed')
		throw err
	}
}

async function runChatLoopRounds(input: RunChatLoopInput): Promise<RunChatLoopResult> {
	const { session } = input
	const startedAt = Date.now()

	// Wave 3 #13 phase 1 — fire `before_run` hook. Fail-isolated, fire-and-forget.
	void emitHook('before_run', {
		runId: session.runId,
		conversationId: input.conversationId,
		userId: input.userId,
		agentId: input.agentId ?? null,
		source: input.isOrchestrator ? 'chat_stream' : 'agent',
	})

	// Wave 5 #20 phase 2 — open a run_traces row at loop start so spans can append as the
	// loop progresses.
	openRunTrace({ runId: session.runId, conversationId: input.conversationId })

	let currentMessages: LoopMessage[] = [...input.initialMessages]
	const allToolCalls: Array<Record<string, unknown>> = []
	let allTextContent = ''
	let assistantContent = ''
	let promptTokens = 0
	let completionTokens = 0
	let cacheCreationInputTokens = 0
	let cacheReadInputTokens = 0
	let firstTokenAt: number | null = null
	let reasoningTokens: number | null = null
	let finishedNaturally = false
	const toolsForRequest = markLastToolForCaching(input.tools)
	const dispatchContext: DispatchContext = {
		session,
		userId: input.userId,
		conversationId: input.conversationId,
		agentId: input.agentId ?? null,
		persistentKey: input.persistentKey,
		worktree: input.worktree,
		projectId: input.projectId,
		offeredTools: offeredToolNames(input.tools),
		approvalRequiredTools: input.approvalRequiredTools,
		isOrchestrator: input.isOrchestrator,
	}

	for (let round = 0; round <= input.maxRounds; round++) {
		await setRunRound(session.runId, round)

		const stream = await streamChat(currentMessages, input.model, toolsForRequest, input.reasoningConfig)

		// Accumulated tool calls for THIS round (streamed piecewise).
		const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = []

		assistantContent = ''
		let assistantReasoning = ''
		const assistantReasoningDetails: ReasoningDetail[] = []

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta as
				| {
						content?: string
						reasoning?: string | null
						reasoningDetails?: ReasoningDetail[]
						toolCalls?: Array<{
							index?: number
							id?: string
							function?: { name?: string; arguments?: string }
						}>
				  }
				| undefined

			const reasoningDelta = delta?.reasoning
			const reasoningDetailDelta = delta?.reasoningDetails
			if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
				assistantReasoning += reasoningDelta
				await session.emit('reasoning', { content: reasoningDelta })
			} else if (reasoningDetailDelta?.length) {
				assistantReasoningDetails.push(...reasoningDetailDelta)
				const fragment = extractReasoningFragment(reasoningDetailDelta)
				if (fragment) {
					assistantReasoning += fragment
					await session.emit('reasoning', { content: fragment })
				}
			}

			const content = delta?.content
			if (content) {
				if (firstTokenAt === null) firstTokenAt = Date.now()
				assistantContent += content
				await session.emit('delta', { content })
				await session.updateRun({
					state: 'running',
					label: 'Generating response',
					lastDelta: assistantContent.slice(-500),
					heartbeat: true,
				})
			}

			const deltaToolCalls = delta?.toolCalls
			if (deltaToolCalls) {
				for (const tc of deltaToolCalls) {
					const idx = tc.index ?? 0
					if (!pendingToolCalls[idx]) {
						pendingToolCalls[idx] = { id: tc.id ?? '', name: '', arguments: '' }
					}
					if (tc.id) pendingToolCalls[idx].id = tc.id
					if (tc.function?.name) pendingToolCalls[idx].name += tc.function.name
					if (tc.function?.arguments) pendingToolCalls[idx].arguments += tc.function.arguments
				}
			}

			if (chunk.usage) {
				const deltas = parseChunkUsageDeltas(chunk.usage)
				promptTokens += deltas.promptTokens
				completionTokens += deltas.completionTokens
				cacheCreationInputTokens += deltas.cacheCreationInputTokens
				cacheReadInputTokens += deltas.cacheReadInputTokens
				if (deltas.reasoningTokens !== null) reasoningTokens = deltas.reasoningTokens
			}

			await session.updateRun({ state: 'running', heartbeat: true })
		}

		// Validate streamed tool calls, parse args once.
		const validToolCalls = pendingToolCalls.filter((tc) => tc.name)
		const plannedToolCalls = validToolCalls.map((tc) => {
			let parsedArgs: unknown = {}
			try {
				parsedArgs = JSON.parse(tc.arguments)
			} catch {
				parsedArgs = {}
			}
			return { id: tc.id, name: tc.name, arguments: tc.arguments, parsedArgs }
		})

		// Capture assistant text for THIS round into ordered blocks.
		if (assistantReasoning.trim()) {
			await session.pushBlock({ kind: 'thinking', content: assistantReasoning.trim() })
		}
		if (assistantContent) {
			await session.pushBlock({ kind: 'text', content: assistantContent })
			allTextContent += (allTextContent ? '\n' : '') + assistantContent
		}

		if (validToolCalls.length === 0) {
			finishedNaturally = true
			break
		}

		// Execute each tool call serially. `dispatchToolCall` refuses a name this run did not
		// offer before approval or execution: these runs pass no approval set, so the offered
		// list is the only thing between the model and the rest of the registry.
		const toolResults: Array<{ call_id: string; name: string; result: string }> = []
		for (const tc of plannedToolCalls) {
			const outcome = await dispatchToolCall(dispatchContext, tc)
			toolResults.push(outcome.toolResult)
			allToolCalls.push(outcome.allToolCallsEntry)
		}

		// Append assistant message + tool results for the next round.
		currentMessages.push({
			role: 'assistant',
			content: assistantContent || '',
			reasoning: assistantReasoning || undefined,
			reasoningDetails: assistantReasoningDetails.length ? assistantReasoningDetails : undefined,
			toolCalls: validToolCalls.map((tc) => ({
				id: tc.id,
				type: 'function' as const,
				function: { name: tc.name, arguments: tc.arguments },
			})),
		})

		for (const tr of toolResults) {
			currentMessages.push({
				role: 'tool',
				content: tr.result,
				toolCallId: tr.call_id,
			})
		}
	}

	// streamBlocks accumulator lives on the session (the detached one exposes .streamBlocks); the loop
	// only mutates via session.pushBlock so it doesn't need to track them itself. Caller reads
	// them off the session for the persisted message metadata.
	const sessionWithBlocks = session as { streamBlocks?: import('$lib/runs/runs.schema').StreamBlock[] }
	const streamBlocks = sessionWithBlocks.streamBlocks ?? []

	// Wave 3 #13 phase 1 — `after_run` hook. Fail-isolated. Cost is null here because the
	// runtime doesn't compute cost; the caller (automation / monitor / CI fix run) does that
	// AFTER the loop returns and feeds it into its own logLlmUsage.
	void emitHook('after_run', {
		runId: session.runId,
		conversationId: input.conversationId,
		userId: input.userId,
		agentId: input.agentId ?? null,
		costUsd: null,
		durationMs: Date.now() - startedAt,
		success: true,
	})

	// Wave 5 #20 phase 2 — flip the run_traces row to `completed`. The caller updates cost
	// after logLlmUsage; we leave costUsd unset here so it's recorded by the caller's own
	// trace-finish call (or stays at the default 0 when the caller skips it).
	closeRunTrace(session.runId)

	return {
		finalText: allTextContent || assistantContent,
		finalReasoning: '',
		reasoningTokens,
		toolCalls: allToolCalls,
		streamBlocks,
		promptTokens,
		completionTokens,
		cacheCreationInputTokens,
		cacheReadInputTokens,
		firstTokenAt: firstTokenAt ? firstTokenAt - startedAt : null,
		finishedNaturally,
	}
}

/**
 * Pull token usage deltas off a single OpenRouter `chunk.usage` payload. Handles the
 * Anthropic prompt-cache stats nested inside `promptTokensDetails` (camelCase) or
 * `prompt_tokens_details` (snake_case) — different SDK versions normalize differently.
 *
 * Returns `reasoningTokens: null` when the chunk doesn't report reasoning tokens; the
 * caller keeps its previous value rather than overwriting it.
 */
function parseChunkUsageDeltas(usage: NonNullable<{ promptTokens?: number; completionTokens?: number }>): {
	promptTokens: number
	completionTokens: number
	cacheCreationInputTokens: number
	cacheReadInputTokens: number
	reasoningTokens: number | null
} {
	const reasoningTokens =
		'completionTokensDetails' in usage
			? (usage as { completionTokensDetails?: { reasoningTokens?: number } })
					.completionTokensDetails?.reasoningTokens ?? null
			: null

	const usageRaw = usage as unknown as {
		promptTokensDetails?: {
			cachedTokens?: number
			cached_tokens?: number
			cacheWriteTokens?: number
			cache_write_tokens?: number
		}
		prompt_tokens_details?: {
			cached_tokens?: number
			cachedTokens?: number
			cache_write_tokens?: number
			cacheWriteTokens?: number
		}
	}
	const details = usageRaw.promptTokensDetails ?? usageRaw.prompt_tokens_details ?? {}

	return {
		promptTokens: usage.promptTokens ?? 0,
		completionTokens: usage.completionTokens ?? 0,
		cacheCreationInputTokens: details.cacheWriteTokens ?? details.cache_write_tokens ?? 0,
		cacheReadInputTokens: details.cachedTokens ?? details.cached_tokens ?? 0,
		reasoningTokens: reasoningTokens ?? null,
	}
}
