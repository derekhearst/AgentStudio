import { streamChat } from '$lib/llm/chat.server'
import { executeTool, toolSchemas, type ToolCallWithContext, type ToolName } from '$lib/tools/tools.server'
import { trimToolResult } from '$lib/chat/chat'
import { trimToolResultWithOffload } from '$lib/tools/output-offload.server'
import { enqueuePendingApproval, awaitApprovalDecision } from '$lib/runs/approvals.server'
import { enqueuePendingQuestion, awaitQuestionAnswers } from '$lib/runs/questions.server'
import { setRunRound } from '$lib/runs/blocks.server'
import { emitHook } from '$lib/hooks'
import type {
	LoopMessage,
	RunChatLoopInput,
	RunChatLoopResult,
	ToolDefinition,
} from './types'
import { logger } from '$lib/observability/logger'

/**
 * Wave 2 #10 phase 1 — extracted chat loop.
 *
 * Behaviorally identical to the for-round body that lived inside the chat-stream `+server.ts`
 * before extraction; every emit / updateRun / pushBlock / executeTool / approval-await /
 * ask-user-await call routes through the same modules as before.
 *
 * The loop is transport-agnostic — it talks to a `Session` (SSE-backed for chat streams,
 * detached for automations + sub-agents) and gets its inputs (model, tool surface, approval
 * set, sub-agent dispatch callback) as a self-contained `RunChatLoopInput`.
 *
 * The caller does:
 *   1. Build the system prompt + initial messages (slot assembly, compaction).
 *   2. Build the session (e.g. `createSseSession`).
 *   3. Call `runChatLoop`.
 *   4. Persist the resulting message + cost + activity rollups.
 */

type ReasoningDetail = {
	type?: string | null
	text?: string | null
	summary?: string | null
	data?: string | null
	[key: string]: unknown
}

function extractReasoningFragment(details: ReasoningDetail[] | undefined): string {
	if (!details?.length) return ''
	return details
		.map((detail) => {
			switch (detail.type) {
				case 'reasoning.text':
					return typeof detail.text === 'string' ? detail.text : ''
				case 'reasoning.summary':
					return typeof detail.summary === 'string' ? detail.summary : ''
				case 'reasoning.encrypted':
					return '[Reasoning hidden by provider]'
				default:
					return typeof detail.text === 'string' ? detail.text : ''
			}
		})
		.join('')
}

export async function runChatLoop(input: RunChatLoopInput): Promise<RunChatLoopResult> {
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
	// loop progresses. Best-effort + dynamic import to avoid loading observability when the
	// runtime is exercised in tests that don't need it.
	void (async () => {
		try {
			const { startRunTrace } = await import('$lib/observability/traces.server')
			await startRunTrace({ runId: session.runId, sessionId: input.conversationId })
		} catch (err) {
			logger.warn('[runtime] startRunTrace failed (non-fatal)', { err })
		}
	})()

	let currentMessages: LoopMessage[] = [...input.initialMessages]
	const allToolCalls: Array<Record<string, unknown>> = []
	let allTextContent = ''
	let assistantContent = ''
	let promptTokens = 0
	let completionTokens = 0
	let firstTokenAt: number | null = null
	let reasoningTokens: number | null = null
	let finishedNaturally = false
	let tools: ToolDefinition[] = input.initialTools

	for (let round = 0; round <= input.maxRounds; round++) {
		await setRunRound(session.runId, round)
		// Refresh the active tool surface so progressive disclosure (`enable_capability` calls in
		// the previous round) takes effect this round. Caller decides whether this is a no-op.
		tools = await input.computeTools()

		const stream = await streamChat(currentMessages, input.model, tools, input.reasoningConfig)

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
				promptTokens += chunk.usage.promptTokens ?? 0
				completionTokens += chunk.usage.completionTokens ?? 0
				if ('completionTokensDetails' in chunk.usage) {
					reasoningTokens =
						chunk.usage.completionTokensDetails?.reasoningTokens ?? reasoningTokens
				}
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

		// Execute each tool call serially.
		const toolResults: Array<{ call_id: string; name: string; result: string }> = []
		for (const tc of plannedToolCalls) {
			const parsedArgs = tc.parsedArgs

			const requiresApproval =
				input.approvalRequiredTools.has('*') || input.approvalRequiredTools.has(tc.name)

			if (requiresApproval) {
				const approvalToken = crypto.randomUUID()
				// Bundle the pendingApprovals enqueue + state transition in a single transaction
				// (inside enqueuePendingApproval) so a crash between the two never leaves the run
				// in `running` state with an invisible pending approval, or vice versa.
				await enqueuePendingApproval(
					session.runId,
					{
						token: approvalToken,
						toolName: tc.name,
						args: parsedArgs,
						requestedAt: new Date().toISOString(),
					},
					{
						state: 'waiting_tool_approval',
						label: `Waiting for approval: ${tc.name}`,
					},
				)
				await session.emit('tool_pending', {
					token: approvalToken,
					id: tc.id,
					name: tc.name,
					arguments: tc.arguments,
				})
				const approved = await awaitApprovalDecision(session.runId, approvalToken)
				await session.updateRun({
					state: 'running',
					label: approved ? `Executing ${tc.name}` : `Denied ${tc.name}`,
					heartbeat: true,
				})
				if (!approved) {
					await session.emit('tool_denied', { id: tc.id, name: tc.name })
					allToolCalls.push({
						name: tc.name,
						arguments: parsedArgs,
						result: { denied: true },
						executionMs: 0,
					})
					toolResults.push({
						call_id: tc.id,
						name: tc.name,
						result: 'Tool execution was denied by user.',
					})
					continue
				}
			}

			// ── ask_user (orchestrator-only)
			if (tc.name === 'ask_user') {
				if (!input.isOrchestrator) {
					const resultStr = trimToolResult(
						tc.name,
						JSON.stringify({
							error:
								'Agents cannot ask users directly. Return this question to the orchestrator to gather user input, then resume the agent with those answers.',
						}),
					)
					await session.emit('tool_result', {
						id: tc.id,
						name: tc.name,
						success: false,
						executionMs: 0,
						result: resultStr,
					})
					toolResults.push({ call_id: tc.id, name: tc.name, result: resultStr })
					allToolCalls.push({
						name: tc.name,
						arguments: parsedArgs,
						result: { denied: true, reason: 'ask_user is restricted to orchestrator conversations' },
						executionMs: 0,
					})
					await session.pushBlock({
						kind: 'tool',
						name: tc.name,
						arguments: parsedArgs,
						result: { denied: true, reason: 'ask_user is restricted to orchestrator conversations' },
						success: false,
						executionMs: 0,
					})
					continue
				}

				let askInput: ReturnType<typeof toolSchemas.ask_user.parse>
				try {
					askInput = toolSchemas.ask_user.parse(parsedArgs)
				} catch {
					const errorMessage = 'ask_user received invalid arguments.'
					const resultStr = trimToolResult(tc.name, JSON.stringify({ error: errorMessage }))
					await session.emit('tool_result', {
						id: tc.id,
						name: tc.name,
						success: false,
						executionMs: 0,
						result: resultStr,
					})
					toolResults.push({ call_id: tc.id, name: tc.name, result: resultStr })
					allToolCalls.push({
						name: tc.name,
						arguments: parsedArgs,
						result: { error: errorMessage },
						executionMs: 0,
					})
					continue
				}

				const questionToken = crypto.randomUUID()
				await enqueuePendingQuestion(
					session.runId,
					{
						token: questionToken,
						questions: askInput.questions,
						requestedAt: new Date().toISOString(),
					},
					{ state: 'waiting_user_input', label: 'Waiting for user input' },
				)
				await session.emit('ask_user', {
					token: questionToken,
					id: tc.id,
					name: tc.name,
					questions: askInput.questions,
				})
				const answers = await awaitQuestionAnswers(session.runId, questionToken)
				await session.updateRun({ state: 'running', label: 'User input received', heartbeat: true })

				const questionResult = {
					questions: askInput.questions,
					answers,
					timedOut: answers === null,
				}
				const resultStr = trimToolResult(tc.name, JSON.stringify(questionResult))
				await session.emit('tool_result', {
					id: tc.id,
					name: tc.name,
					success: answers !== null,
					executionMs: 0,
					result: resultStr,
				})
				toolResults.push({ call_id: tc.id, name: tc.name, result: resultStr })
				allToolCalls.push({
					name: tc.name,
					arguments: parsedArgs,
					result: questionResult,
					executionMs: 0,
				})
				await session.pushBlock({
					kind: 'tool',
					name: tc.name,
					arguments: parsedArgs,
					result: questionResult,
					success: answers !== null,
					executionMs: 0,
				})
				continue
			}

			await session.updateRun({
				state: 'running',
				label: `Executing ${tc.name}`,
				heartbeat: true,
			})
			await session.emit('tool_call', { id: tc.id, name: tc.name, arguments: tc.arguments })

			// ── run_subagent (orchestrator-only — delegates via injected callback)
			if (tc.name === 'run_subagent' && input.isOrchestrator && input.spawnSubagent) {
				const subagentArgs = parsedArgs as { task?: string; context?: string; agentId?: string }
				if (subagentArgs.agentId && subagentArgs.task) {
					try {
						const subResult = await input.spawnSubagent({
							agentId: subagentArgs.agentId,
							task: subagentArgs.task,
							context: subagentArgs.context,
						})
						const resultStr = trimToolResult(
							tc.name,
							JSON.stringify({
								success: true,
								agentConversationId: subResult.conversationId,
								result: subResult.result.slice(0, 4000),
							}),
						)
						toolResults.push({ call_id: tc.id, name: tc.name, result: resultStr })
						await session.emit('tool_result', {
							id: tc.id,
							name: tc.name,
							success: true,
							executionMs: 0,
							result: resultStr,
						})
						allToolCalls.push({
							name: tc.name,
							arguments: parsedArgs,
							result: {
								agentConversationId: subResult.conversationId,
								result: subResult.result.slice(0, 4000),
							},
							executionMs: 0,
						})
						await session.pushBlock({
							kind: 'tool',
							name: tc.name,
							arguments: parsedArgs,
							result: {
								agentConversationId: subResult.conversationId,
								result: subResult.result.slice(0, 4000),
							},
							success: true,
							executionMs: 0,
						})
					} catch (error) {
						const errorStr =
							error instanceof Error ? error.message : 'Sub-agent execution failed'
						toolResults.push({ call_id: tc.id, name: tc.name, result: `Error: ${errorStr}` })
						await session.emit('tool_result', {
							id: tc.id,
							name: tc.name,
							success: false,
							executionMs: 0,
							result: errorStr,
						})
						allToolCalls.push({
							name: tc.name,
							arguments: parsedArgs,
							result: { error: errorStr },
							executionMs: 0,
						})
						await session.pushBlock({
							kind: 'tool',
							name: tc.name,
							arguments: parsedArgs,
							result: { error: errorStr },
							success: false,
							executionMs: 0,
						})
					}
					continue
				}
			}

			// ── normal tool dispatch
			const toolCall: ToolCallWithContext = {
				name: tc.name as ToolName,
				arguments: parsedArgs,
				conversationId: input.conversationId,
				messageId: null,
			}

			// Wave 3 #13 phase 1 — `before_tool` hook. Fail-isolated.
			void emitHook('before_tool', {
				runId: session.runId,
				conversationId: input.conversationId,
				userId: input.userId,
				agentId: input.agentId ?? null,
				toolName: tc.name,
				args: parsedArgs,
			})

			const toolResult = await executeTool(toolCall, input.userId, session.runId, {
				persistentKey: input.persistentKey,
				worktree: input.worktree,
			})

			// Wave 3 #13 phase 1 — `after_tool` hook. Fail-isolated.
			void emitHook('after_tool', {
				runId: session.runId,
				conversationId: input.conversationId,
				userId: input.userId,
				agentId: input.agentId ?? null,
				toolName: tc.name,
				args: parsedArgs,
				result: toolResult.success ? toolResult.result : { error: toolResult.error },
				success: toolResult.success,
				durationMs: toolResult.executionMs,
			})

			// Wave 5 #20 phase 2 — record a tool_call span on the run's trace.
			void (async () => {
				try {
					const { appendTraceSpan } = await import('$lib/observability/traces.server')
					await appendTraceSpan(session.runId, {
						kind: 'tool_call',
						startedAt: new Date(Date.now() - toolResult.executionMs).toISOString(),
						durationMs: toolResult.executionMs,
						success: toolResult.success,
						toolName: tc.name,
					})
				} catch (err) {
					logger.warn('[runtime] appendTraceSpan failed (non-fatal)', { err })
				}
			})()

			const rawResultStr = toolResult.success
				? JSON.stringify(toolResult.result)
				: `Error: ${toolResult.error}`
			const trimmed = await trimToolResultWithOffload({
				toolName: tc.name,
				content: rawResultStr,
				callId: tc.id,
				userId: input.userId,
				runId: session.runId,
				persistentKey: input.persistentKey,
				worktree: input.worktree,
			})
			const resultStr = trimmed.visible

			toolResults.push({ call_id: tc.id, name: tc.name, result: resultStr })
			await session.emit('tool_result', {
				id: tc.id,
				name: tc.name,
				success: toolResult.success,
				executionMs: toolResult.executionMs,
				result: resultStr,
				offloadedHandle: trimmed.handle,
				fullSize: trimmed.fullSize,
			})

			allToolCalls.push({
				name: tc.name,
				arguments: parsedArgs,
				result: toolResult.success ? toolResult.result : { error: toolResult.error },
				success: toolResult.success,
				executionMs: toolResult.executionMs,
			})
			await session.pushBlock({
				kind: 'tool',
				name: tc.name,
				arguments: parsedArgs,
				result: toolResult.success ? toolResult.result : { error: toolResult.error },
				success: toolResult.success,
				executionMs: toolResult.executionMs,
			})
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

	// streamBlocks accumulator lives on the session (SSE impl exposes .streamBlocks); the loop
	// only mutates via session.pushBlock so it doesn't need to track them itself. Caller reads
	// them off the session for the persisted message metadata.
	const sessionWithBlocks = session as { streamBlocks?: import('$lib/runs/runs.schema').StreamBlock[] }
	const streamBlocks = sessionWithBlocks.streamBlocks ?? []

	// Wave 3 #13 phase 1 — `after_run` hook. Fail-isolated. Cost is null here because the
	// runtime doesn't compute cost; the caller (chat stream / inline-subagent / automation /
	// task-runner) does that AFTER the loop returns and feeds it into its own logLlmUsage.
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
	void (async () => {
		try {
			const { finishRunTrace } = await import('$lib/observability/traces.server')
			await finishRunTrace({ runId: session.runId, status: 'completed' })
		} catch (err) {
			logger.warn('[runtime] finishRunTrace failed (non-fatal)', { err })
		}
	})()

	return {
		finalText: allTextContent || assistantContent,
		finalReasoning: '',
		reasoningTokens,
		toolCalls: allToolCalls,
		streamBlocks,
		promptTokens,
		completionTokens,
		firstTokenAt: firstTokenAt ? firstTokenAt - startedAt : null,
		finishedNaturally,
	}
}
