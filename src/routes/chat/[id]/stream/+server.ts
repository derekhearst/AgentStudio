import { json, type RequestHandler } from '@sveltejs/kit'
import { and, asc, desc, eq, gt } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { chatRuns, type StreamBlock } from '$lib/runs/runs.schema'
import { streamChat, type LlmMessage } from '$lib/llm/chat.server'
import { generateTitle, shouldCompact, compactMessages, estimateMessageTokens } from '$lib/chat/chat.server'
import { getContextWindowSize } from '$lib/tools/tools'
import { emitActivity } from '$lib/activity/activity.server'
import { executeTool, getToolDefinitions, type ToolName, type ToolCallWithContext } from '$lib/tools/tools.server'
import { logLlmUsage } from '$lib/costs/usage'
import { checkBudgetLimits, recordBudgetAlert } from '$lib/costs/budget.server'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { enqueuePendingApproval, awaitApprovalDecision } from '$lib/runs/approvals.server'
import { enqueuePendingQuestion, awaitQuestionAnswers } from '$lib/runs/questions.server'
import { persistRunBlocks, setRunRound } from '$lib/runs/blocks.server'
import { appendRunEvent } from '$lib/runs/events.server'
import { toolSchemas } from '$lib/tools/tools.server'
import { listSkillSummaries, listRelevantSkillSummaries } from '$lib/skills/skills.server'
import { trimHistoricalToolResults, trimToolResult } from '$lib/chat/chat'
import { buildOrchestratorPrompt } from '$lib/agents/orchestrator'
import { runInlineSubagent } from '$lib/agents/inline-subagent'
import { recallForUser, renderMemoryContext, mineConversation } from '$lib/memory/memory.server'
import { assembleSystemPrompt, applySlotOverrides, type ContextSlot } from '$lib/context/slots.server'
import { loadSlotOverrides } from '$lib/context/overrides.server'
import { getModePostureContent } from '$lib/chat/mode.server'

const encoder = new TextEncoder()

const DREAMING_ONLY_TOOLS = new Set<string>()

type StreamPayload = {
	conversationId: string
	content?: string
	model?: string
	reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
	regenerate?: boolean
	attachments?: Array<{ id: string; filename: string; mimeType: string; size: number; url: string }>
}

type ChatRunState = (typeof chatRuns.$inferInsert)['state']

type LoopMessage = LlmMessage & {
	toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
	toolCallId?: string
}

type ReasoningDetail = {
	type?: string | null
	text?: string | null
	summary?: string | null
	data?: string | null
	[key: string]: unknown
}

function extractReasoningFragment(details: ReasoningDetail[] | undefined) {
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
					return typeof detail.text === 'string'
						? detail.text
						: typeof detail.summary === 'string'
							? detail.summary
							: ''
			}
		})
		.filter(Boolean)
		.join('\n\n')
}

function sse(name: string, payload: unknown, seq?: number) {
	const idLine = seq === undefined ? '' : `id: ${seq}\n`
	return encoder.encode(`${idLine}event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}
	const user = locals.user

	const body = (await request.json()) as StreamPayload
	if (!body.conversationId) {
		return json({ error: 'conversationId is required' }, { status: 400 })
	}

	const [conversation] = await db
		.select()
		.from(conversations)
		.where(and(eq(conversations.id, body.conversationId), eq(conversations.userId, user.id)))
		.limit(1)

	if (!conversation) {
		return json({ error: 'Conversation not found' }, { status: 404 })
	}

	const currentSettings = await getOrCreateSettings(user.id)
	const selectedModel = body.model?.trim()
	const routedModel = selectedModel && selectedModel.length > 0 ? selectedModel : currentSettings.defaultModel
	const reasoningEffort = body.reasoningEffort ?? 'none'
	const reasoningConfig =
		reasoningEffort === 'none' ? undefined : { enabled: true, exclude: false, effort: reasoningEffort }
	const modelSelection = {
		source: selectedModel ? ('user' as const) : ('settingsDefault' as const),
		reason: selectedModel ? 'User-selected model' : 'Default model from settings',
	}
	let parentMessageId: string | null = null

	if (!body.regenerate) {
		if (!body.content || body.content.trim().length === 0) {
			return json({ error: 'content is required when regenerate=false' }, { status: 400 })
		}

		const [createdUser] = await db
			.insert(messages)
			.values({
				conversationId: body.conversationId,
				role: 'user',
				content: body.content.trim(),
				model: routedModel,
				metadata: {},
				toolCalls: [],
				attachments: body.attachments ?? [],
			})
			.returning()

		parentMessageId = createdUser.id
	} else {
		const [lastUser] = await db
			.select()
			.from(messages)
			.where(and(eq(messages.conversationId, body.conversationId), eq(messages.role, 'user')))
			.orderBy(desc(messages.createdAt))
			.limit(1)
		parentMessageId = lastUser?.id ?? null
	}

	const historyRows = await db
		.select({ role: messages.role, content: messages.content, attachments: messages.attachments })
		.from(messages)
		.where(eq(messages.conversationId, body.conversationId))
		.orderBy(asc(messages.createdAt))

	// First exchange = only the message we just inserted exists (historyRows has exactly 1 row)
	const isFirstExchange = historyRows.length === 1 && !body.regenerate

	if (isFirstExchange) {
		void emitActivity('chat_started', `Chat started: ${conversation.title}`, {
			entityId: body.conversationId,
			entityType: 'conversation',
		})
	}

	const llmMessages: LlmMessage[] = historyRows
		.filter((row) => row.role === 'system' || row.role === 'user' || row.role === 'assistant')
		.map((row) => {
			const imageAttachments = (row.attachments ?? []).filter((a) => a.mimeType.startsWith('image/'))
			if (imageAttachments.length > 0 && row.role === 'user') {
				return {
					role: row.role,
					content: [
						{ type: 'text' as const, text: row.content },
						...imageAttachments.map((a) => ({
							type: 'image_url' as const,
							image_url: { url: a.url },
						})),
					],
				}
			}
			return { role: row.role, content: row.content }
		})

	// --- Context Engineering: Unified System Prompt ---
	const toolConfig = currentSettings.toolConfig as
		| {
				approvalRequiredTools?: string[]
				approvalMode?: string
		  }
		| undefined
	const approvalRequiredTools = new Set(
		toolConfig?.approvalRequiredTools ?? (toolConfig?.approvalMode === 'confirm' ? ['*'] : []),
	)

	// Build skill summaries so the model can lazily load details with read_skill/read_skill_file.
	// Phase 4 of #4: filter by relevance to the user's query when available, capped to skillTopK
	// (default 8). Falls back to listing everything when no user content yet (e.g. regenerate
	// of a system-prompted run) or when embeddings are unavailable.
	const skillTopK = Math.max(
		1,
		((currentSettings.contextConfig as { skillTopK?: number } | null)?.skillTopK ?? 8),
	)
	let skillSummariesText: string | undefined
	const skillSummaries =
		body.content && body.content.trim().length > 0
			? await listRelevantSkillSummaries(body.content.trim(), skillTopK)
			: await listSkillSummaries()
	if (skillSummaries.length > 0) {
		skillSummariesText = skillSummaries
			.map((s) => {
				const fileNames = s.files.map((f) => f.name).join(', ')
				return `- ${s.name}: ${s.description}${fileNames ? ` [files: ${fileNames}]` : ''}`
			})
			.join('\n')
	}

	const contextSlots: ContextSlot[] = []
	let scopedAgentTools: string[] | null = null
	let persistentKey: string | null = null
	let worktreeConfig: { repoPath: string; baseBranch?: string; deleteBranchOnCleanup?: boolean } | null = null

	// --- Context Engineering: Mode Posture (chat workbench mode) ---
	if (conversation.mode && conversation.mode !== 'chat') {
		contextSlots.push({
			name: `mode_${conversation.mode}`,
			priority: 95,
			content: await getModePostureContent(conversation.mode),
		})
	}

	// --- Context Engineering: Orchestrator / Agent Identity ---
	const isOrchestrator = !conversation.agentId
	if (isOrchestrator) {
		const orchestratorPrompt = await buildOrchestratorPrompt()
		contextSlots.push({ name: 'identity', priority: 100, content: orchestratorPrompt })
	} else {
		// Agent conversation — load agent's own system prompt
		const { agents: agentsTable } = await import('$lib/agents/agents.schema')
		const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, conversation.agentId!)).limit(1)
		if (agent) {
			contextSlots.push({ name: 'identity', priority: 100, content: agent.systemPrompt })
			const config = agent.config as
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
			if (Array.isArray(config?.allowedTools) && config.allowedTools.length > 0) {
				scopedAgentTools = config.allowedTools
			}
			// Phase 2 of #7: opt-in persistent workspace per agent.
			if (
				config?.workspace?.mode === 'persistent' &&
				typeof config.workspace.key === 'string' &&
				config.workspace.key.length > 0
			) {
				persistentKey = config.workspace.key
			}
			// Phase 4 of #7: opt-in git-worktree workspace per agent. The agent config supplies
			// the source repoPath; the worktree itself is created lazily on first tool use via
			// ensureWorkspace, off a `run/<runId>` branch from `baseBranch` (default: repo HEAD).
			if (
				config?.workspace?.mode === 'worktree' &&
				typeof config.workspace.repoPath === 'string' &&
				config.workspace.repoPath.length > 0
			) {
				worktreeConfig = {
					repoPath: config.workspace.repoPath,
					baseBranch: config.workspace.baseBranch,
					deleteBranchOnCleanup: config.workspace.deleteBranchOnCleanup,
				}
			}
		}
	}

	if (currentSettings.systemPrompt?.trim()) {
		// Reserved for optional future system prompt handling.
	}
	if (isOrchestrator) {
		contextSlots.push({
			name: 'tool_policy',
			priority: 90,
			content: [
				'Tool usage policy:',
				'- If the user asks you to ask questions, gather preferences with options, or confirm choices before continuing, you MUST call the ask_user tool.',
				"- Do not only say you'll ask a question in plain text when ask_user is appropriate.",
				'- Use concise questions with clear option labels, and allow freeform input when the request is open-ended.',
				'- For ask_user: aim for ~3 prefilled answer options per question. Prefer asking more focused questions (split complex choices across multiple questions) rather than listing many options in one question.',
			].join('\n'),
		})
	} else {
		contextSlots.push({
			name: 'tool_policy',
			priority: 90,
			content: [
				'Tool usage policy:',
				'- You cannot call ask_user directly in agent conversations.',
				'- If you need user input, summarize missing information and return control to orchestrator for follow-up.',
			].join('\n'),
		})
	}
	if (skillSummariesText) {
		contextSlots.push({
			name: 'skills',
			priority: 70,
			content: `Available skills (use read_skill to load full content when relevant):\n${skillSummariesText}`,
			truncationStrategy: 'truncate-end',
		})
	}

	// --- Context Engineering: Memory Palace Recall ---
	const memoryConfig = (currentSettings.memoryConfig ?? null) as {
		enabled?: boolean
		topK?: number
		useRerank?: boolean
		rerankModel?: string
	} | null
	const memoryEnabled = memoryConfig?.enabled !== false
	if (memoryEnabled && body.content && body.content.trim().length > 0) {
		try {
			const recalled = await recallForUser(user.id, body.content.trim(), {
				topK: memoryConfig?.topK ?? 5,
				useRerank: memoryConfig?.useRerank ?? false,
				rerankModel: memoryConfig?.rerankModel,
			})
			const memoryBlock = renderMemoryContext(recalled)
			if (memoryBlock) {
				contextSlots.push({
					name: 'memory',
					priority: 60,
					content: memoryBlock,
					truncationStrategy: 'truncate-end',
				})
			}
		} catch (err) {
			console.warn('[memory] recall failed', err)
		}
	}

	// Phase 8 of #4: per-(user, agent) slot overrides. Lets users disable slots, raise/lower
	// priority, or set per-slot token caps from /agents/[id]/settings (UI follow-up).
	const slotOverrides = await loadSlotOverrides(user.id, conversation.agentId)
	const overriddenSlots = applySlotOverrides(contextSlots, slotOverrides)
	const assembled = assembleSystemPrompt(overriddenSlots)
	const capabilityPrompt = assembled.systemPrompt

	if (capabilityPrompt) {
		llmMessages.unshift({
			role: 'system',
			content: capabilityPrompt,
		})
	}

	// --- Context Engineering: Conversation Compaction ---
	const compactionCheck = await shouldCompact(llmMessages, routedModel, user.id)
	let didCompact = false
	if (compactionCheck.needed) {
		const result = await compactMessages(llmMessages, user.id, routedModel)
		if (result.summary) {
			llmMessages.length = 0
			llmMessages.push(...result.compacted)
			didCompact = true
		}
	}

	// --- Context Engineering: Trim Historical Tool Results ---
	const trimmedMessages = trimHistoricalToolResults(llmMessages)

	const startedAt = Date.now()
	let firstTokenAt: number | null = null
	let assistantContent = ''
	let promptTokens = 0
	let completionTokens = 0

	// --- Context Engineering: Tool Loading ---
	let tools = getToolDefinitions()
		.filter((tool) => (isOrchestrator ? true : tool.function.name !== 'ask_user'))
		.filter((tool) =>
			scopedAgentTools ? scopedAgentTools.includes(tool.function.name) : !DREAMING_ONLY_TOOLS.has(tool.function.name),
		)
	// No hard limit ΓÇö loop exits when the model stops calling tools
	const MAX_TOOL_ROUNDS = 50

	// Phase 3 of #5: budget enforcement BEFORE creating the run row, so a `block` cap
	// short-circuits without leaving an orphan run. Warnings are non-blocking and just
	// fire alert rows.
	const budgetCheck = await checkBudgetLimits({
		userId: user.id,
		agentId: conversation.agentId,
	})
	for (const w of budgetCheck.warnings) {
		try {
			await recordBudgetAlert({ limit: w.limit, triggerType: 'warn', spendUsd: w.spendUsd })
		} catch (err) {
			console.warn('[budget] warn alert insert failed', err)
		}
	}
	if (!budgetCheck.allowed && budgetCheck.blockedBy) {
		// Await the alert write so callers querying budget_alerts immediately after the 402
		// response see the row (no fire-and-forget race).
		try {
			await recordBudgetAlert({
				limit: budgetCheck.blockedBy,
				triggerType: 'block',
				spendUsd: parseFloat(budgetCheck.blockedBy.limitUsd),
			})
		} catch (err) {
			console.warn('[budget] block alert insert failed', err)
		}
		return json(
			{
				error: 'budget_exceeded',
				message: `Budget cap exceeded: ${budgetCheck.blockedBy.scope} ${budgetCheck.blockedBy.period} limit of $${budgetCheck.blockedBy.limitUsd}`,
				limitId: budgetCheck.blockedBy.id,
			},
			{ status: 402 },
		)
	}

	const [run] = await db
		.insert(chatRuns)
		.values({
			conversationId: body.conversationId,
			userId: user.id,
			agentId: conversation.agentId,
			state: 'running',
			source: 'chat_stream',
			label: body.regenerate ? 'Regenerating response' : 'Generating response',
			startedAt: new Date(),
			lastHeartbeatAt: new Date(),
		})
		.returning({ id: chatRuns.id })

	const readable = new ReadableStream<Uint8Array>({
		async start(controller) {
			let clientConnected = true
			let lastHeartbeatWriteAt = 0

			const safeController = {
				enqueue(chunk: Uint8Array) {
					if (!clientConnected) return
					try {
						controller.enqueue(chunk)
					} catch {
						clientConnected = false
					}
				},
			} as ReadableStreamDefaultController<Uint8Array>

			const NON_PERSISTED_EVENTS = new Set(['delta', 'reasoning'])
			const emit = async (eventName: string, payload: unknown) => {
				let seq: number | undefined
				if (!NON_PERSISTED_EVENTS.has(eventName)) {
					try {
						seq = await appendRunEvent(run.id, eventName, payload)
					} catch (err) {
						console.error('[chat/stream] failed to log run event', {
							runId: run.id,
							eventName,
							error: err instanceof Error ? err.message : String(err),
						})
					}
				}
				safeController.enqueue(sse(eventName, payload, seq))
			}

			const updateRun = async (patch: {
				state?: ChatRunState
				label?: string | null
				lastDelta?: string | null
				error?: string | null
				heartbeat?: boolean
				finished?: boolean
			}) => {
				const now = Date.now()
				if (
					patch.heartbeat &&
					!patch.state &&
					patch.label === undefined &&
					patch.lastDelta === undefined &&
					patch.error === undefined &&
					now - lastHeartbeatWriteAt < 1000
				) {
					return
				}

				const values: Partial<typeof chatRuns.$inferInsert> = {
					updatedAt: new Date(now),
				}
				if (patch.state) values.state = patch.state
				if (patch.label !== undefined) values.label = patch.label
				if (patch.lastDelta !== undefined) values.lastDelta = patch.lastDelta
				if (patch.error !== undefined) values.error = patch.error
				if (patch.heartbeat || patch.state === 'running') values.lastHeartbeatAt = new Date(now)
				if (patch.finished) values.finishedAt = new Date(now)

				await db.update(chatRuns).set(values).where(eq(chatRuns.id, run.id))
				if (patch.heartbeat || patch.state === 'running') {
					lastHeartbeatWriteAt = now
				}
			}

			try {
				// Notify client if compaction occurred
				if (didCompact) {
					await emit('compaction', { tokensBefore: compactionCheck.tokenEstimate })
				}

				// Phase 7 of #4: emit a context_stats snapshot so the chat workbench can show
				// the real prompt-assembly footprint (tokenizer-accurate) rather than estimating
				// client-side. Sent once at the top of the stream; cheap to compute.
				await emit('context_stats', {
					runId: run.id,
					tokenEstimate: estimateMessageTokens(trimmedMessages, routedModel),
					contextWindow: getContextWindowSize(routedModel),
					didCompact,
					includedSlots: assembled.includedSlots,
					droppedSlots: assembled.droppedSlots,
					truncatedSlots: assembled.truncatedSlots,
					systemPromptTokens: assembled.estimatedTokens,
				})

				let currentMessages: LoopMessage[] = [...trimmedMessages]
				const allToolCalls: Array<Record<string, unknown>> = []
				// Ordered blocks for interleaved rendering in the UI; mirrored to chat_runs.streamBlocks per push.
				const streamBlocks: StreamBlock[] = []
				const pushBlock = async (block: StreamBlock) => {
					streamBlocks.push(block)
					await persistRunBlocks(run.id, streamBlocks)
				}
				let allTextContent = ''

				let reasoningTokens: number | null = null

				for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
					await setRunRound(run.id, round)
					const stream = await streamChat(currentMessages, routedModel, tools, reasoningConfig)

					// Accumulated tool calls for this round (streamed piecewise)
					const pendingToolCalls: Array<{
						id: string
						name: string
						arguments: string
					}> = []

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
							await emit('reasoning', { content: reasoningDelta })
						} else if (reasoningDetailDelta?.length) {
							assistantReasoningDetails.push(...reasoningDetailDelta)
							const fragment = extractReasoningFragment(reasoningDetailDelta)
							if (fragment) {
								assistantReasoning += fragment
								await emit('reasoning', { content: fragment })
							}
						}
						const content = delta?.content
						if (content) {
							if (firstTokenAt === null) {
								firstTokenAt = Date.now()
							}
							assistantContent += content
							await emit('delta', { content })
							await updateRun({
								state: 'running',
								label: 'Generating response',
								lastDelta: assistantContent.slice(-500),
								heartbeat: true,
							})
						}

						// Accumulate streamed tool calls
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
								reasoningTokens = chunk.usage.completionTokensDetails?.reasoningTokens ?? reasoningTokens
							}
						}

						await updateRun({ state: 'running', heartbeat: true })
					}

					// Check for finish_reason tool_calls or pending tool calls
					const validToolCalls = pendingToolCalls.filter((tc) => tc.name)
					const plannedToolCalls = validToolCalls.map((tc) => {
						let parsedArgs: unknown = {}
						try {
							parsedArgs = JSON.parse(tc.arguments)
						} catch {
							parsedArgs = {}
						}
						return {
							id: tc.id,
							name: tc.name,
							arguments: tc.arguments,
							parsedArgs,
						}
					})

					// Capture assistant text for this round into ordered blocks
					if (assistantReasoning.trim()) {
						await pushBlock({ kind: 'thinking', content: assistantReasoning.trim() })
					}
					if (assistantContent) {
						await pushBlock({ kind: 'text', content: assistantContent })
						allTextContent += (allTextContent ? '\n' : '') + assistantContent
					}

					if (validToolCalls.length === 0) {
						// No tool calls ΓÇö we're done
						break
					}

					// Execute each tool call
					const toolResults: Array<{ call_id: string; name: string; result: string }> = []
					for (const tc of plannedToolCalls) {
						const parsedArgs = tc.parsedArgs

						const requiresApproval = approvalRequiredTools.has('*') || approvalRequiredTools.has(tc.name)

						if (requiresApproval) {
							const approvalToken = crypto.randomUUID()
							await enqueuePendingApproval(run.id, {
								token: approvalToken,
								toolName: tc.name,
								args: parsedArgs,
								requestedAt: new Date().toISOString(),
							})
							await updateRun({ state: 'waiting_tool_approval', label: `Waiting for approval: ${tc.name}` })
							await emit('tool_pending', {
								token: approvalToken,
								id: tc.id,
								name: tc.name,
								arguments: tc.arguments,
							})
							const approved = await awaitApprovalDecision(run.id, approvalToken)
							await updateRun({
								state: 'running',
								label: approved ? `Executing ${tc.name}` : `Denied ${tc.name}`,
								heartbeat: true,
							})
							if (!approved) {
								await emit('tool_denied', {
									id: tc.id,
									name: tc.name,
								})
								allToolCalls.push({
									name: tc.name,
									arguments: parsedArgs,
									result: { denied: true },
									executionMs: 0,
								})
								toolResults.push({ call_id: tc.id, name: tc.name, result: 'Tool execution was denied by user.' })
								continue
							}
						}

						if (tc.name === 'ask_user') {
							if (!isOrchestrator) {
								const resultStr = trimToolResult(
									tc.name,
									JSON.stringify({
										error:
											'Agents cannot ask users directly. Return this question to the orchestrator to gather user input, then resume the agent with those answers.',
									}),
								)
								await emit('tool_result', {
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
								await pushBlock({
									kind: 'tool',
									name: tc.name,
									arguments: parsedArgs,
									result: { denied: true, reason: 'ask_user is restricted to orchestrator conversations' },
									success: false,
									executionMs: 0,
								})
								continue
							}

							let input: {
								questions: Array<{
									header: string
									question: string
									options: Array<{ label: string; description?: string; recommended?: boolean }>
									allowFreeformInput: boolean
								}>
							}
							try {
								input = toolSchemas.ask_user.parse(parsedArgs)
							} catch {
								const errorMessage = 'ask_user received invalid arguments.'
								await emit('tool_result', {
									name: tc.name,
									success: false,
									executionMs: 0,
									result: errorMessage,
								})
								allToolCalls.push({
									name: tc.name,
									arguments: parsedArgs,
									result: { error: errorMessage },
									executionMs: 0,
								})
								toolResults.push({ call_id: tc.id, name: tc.name, result: errorMessage })
								continue
							}

							const questionToken = crypto.randomUUID()
							await enqueuePendingQuestion(run.id, {
								token: questionToken,
								questions: input.questions,
								requestedAt: new Date().toISOString(),
							})
							await updateRun({ state: 'waiting_user_input', label: 'Waiting for user input' })
							await emit('ask_user', {
								token: questionToken,
								id: tc.id,
								name: tc.name,
								questions: input.questions,
							})

							const answers = await awaitQuestionAnswers(run.id, questionToken)
							await updateRun({ state: 'running', label: 'User input received', heartbeat: true })

							const questionResult = {
								questions: input.questions,
								answers,
								timedOut: answers === null,
							}
							const resultStr = trimToolResult(tc.name, JSON.stringify(questionResult))

							await emit('tool_result', {
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
							await pushBlock({
								kind: 'tool',
								name: tc.name,
								arguments: parsedArgs,
								result: questionResult,
								success: answers !== null,
								executionMs: 0,
							})
							continue
						}

						await updateRun({ state: 'running', label: `Executing ${tc.name}`, heartbeat: true })
						await emit('tool_call', {
							id: tc.id,
							name: tc.name,
							arguments: tc.arguments,
						})

						// Intercept run_subagent with agentId for inline sub-agent streaming
						if (tc.name === 'run_subagent' && isOrchestrator) {
							const subagentArgs = parsedArgs as { task?: string; context?: string; agentId?: string }
							if (subagentArgs.agentId && subagentArgs.task) {
								try {
									const subResult = await runInlineSubagent(
										{
											agentId: subagentArgs.agentId,
											agentName: subagentArgs.agentId.slice(0, 8),
											task: subagentArgs.context
												? `${subagentArgs.context}\n\n${subagentArgs.task}`
												: subagentArgs.task,
										},
										user.id,
										body.conversationId,
										safeController,
									)
									const resultStr = trimToolResult(
										tc.name,
										JSON.stringify({
											success: true,
											agentConversationId: subResult.conversationId,
											result: subResult.result.slice(0, 4000),
										}),
									)
									toolResults.push({ call_id: tc.id, name: tc.name, result: resultStr })
									await emit('tool_result', {
										id: tc.id,
										name: tc.name,
										success: true,
										executionMs: 0,
										result: resultStr,
									})
									allToolCalls.push({
										name: tc.name,
										arguments: parsedArgs,
										result: { agentConversationId: subResult.conversationId, result: subResult.result.slice(0, 4000) },
										executionMs: 0,
									})
									await pushBlock({
										kind: 'tool',
										name: tc.name,
										arguments: parsedArgs,
										result: { agentConversationId: subResult.conversationId, result: subResult.result.slice(0, 4000) },
										success: true,
										executionMs: 0,
									})
								} catch (error) {
									const errorStr = error instanceof Error ? error.message : 'Sub-agent execution failed'
									toolResults.push({ call_id: tc.id, name: tc.name, result: `Error: ${errorStr}` })
									await emit('tool_result', {
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
									await pushBlock({
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

						const toolCall: ToolCallWithContext = {
							name: tc.name as ToolName,
							arguments: parsedArgs,
							conversationId: body.conversationId,
							messageId: null,
						}

						const toolResult = await executeTool(toolCall, user.id, run.id, {
							persistentKey,
							worktree: worktreeConfig,
						})

						const rawResultStr = toolResult.success ? JSON.stringify(toolResult.result) : `Error: ${toolResult.error}`
						const resultStr = trimToolResult(tc.name, rawResultStr)

						toolResults.push({ call_id: tc.id, name: tc.name, result: resultStr })

						await emit('tool_result', {
							id: tc.id,
							name: tc.name,
							success: toolResult.success,
							executionMs: toolResult.executionMs,
							result: resultStr,
						})

						allToolCalls.push({
							name: tc.name,
							arguments: parsedArgs,
							result: toolResult.success ? toolResult.result : { error: toolResult.error },
							executionMs: toolResult.executionMs,
						})
						await pushBlock({
							kind: 'tool',
							name: tc.name,
							arguments: parsedArgs,
							result: toolResult.success ? toolResult.result : { error: toolResult.error },
							success: toolResult.success,
							executionMs: toolResult.executionMs,
						})
					}

					// Append assistant message with tool_calls + tool results to conversation for next round
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

				const totalMs = Date.now() - startedAt
				const ttftMs = firstTokenAt ? firstTokenAt - startedAt : null
				const tokensPerSec = totalMs > 0 ? Math.round((completionTokens / (totalMs / 1000)) * 100) / 100 : null
				for (let i = streamBlocks.length - 1; i >= 0; i--) {
					const block = streamBlocks[i]
					if (block.kind === 'thinking') {
						block.reasoningTokens = reasoningTokens
						break
					}
				}
				await persistRunBlocks(run.id, streamBlocks)

				const messageCost = await logLlmUsage({
					source: 'chat',
					model: routedModel,
					tokensIn: promptTokens,
					tokensOut: completionTokens,
					userId: user.id,
					runId: run.id,
					agentId: conversation.agentId ?? null,
					metadata: { conversationId: body.conversationId },
				})

				const [assistantMessage] = await db
					.insert(messages)
					.values({
						conversationId: body.conversationId,
						role: 'assistant',
						content: allTextContent || assistantContent || '(no output)',
						model: routedModel,
						parentMessageId,
						tokensIn: promptTokens,
						tokensOut: completionTokens,
						ttftMs,
						totalMs,
						tokensPerSec,
						cost: messageCost,
						metadata: {
							modelSelection,
							reasoningEffort,
							reasoningTokens,
							blocks: streamBlocks.length > 0 ? streamBlocks : undefined,
						},
						toolCalls: allToolCalls,
					})
					.returning()

				await db
					.update(conversations)
					.set({
						model: routedModel,
						totalTokens: conversation.totalTokens + promptTokens + completionTokens,
						totalCost: String(parseFloat(conversation.totalCost) + parseFloat(messageCost)),
						updatedAt: new Date(),
					})
					.where(eq(conversations.id, body.conversationId))

				if (isFirstExchange && body.content) {
					void generateTitle([
						{ role: 'user', content: body.content.trim() },
						{ role: 'assistant', content: allTextContent || assistantContent || '' },
					])
						.then((title) => db.update(conversations).set({ title }).where(eq(conversations.id, body.conversationId)))
						.catch(() => {
							// Non-critical ΓÇö title stays as default
						})
				}

				await updateRun({
					state: 'completed',
					label: 'Completed',
					lastDelta: (allTextContent || assistantContent || '').slice(-500),
					heartbeat: true,
					finished: true,
				})

				// --- Memory Palace: mine the latest exchange asynchronously ---
				const autoMine = (currentSettings.memoryConfig as { autoMine?: boolean } | null)?.autoMine !== false
				if (autoMine) {
					void mineConversation({ conversationId: body.conversationId }).catch((err) => {
						console.warn('[memory] mining failed', err)
					})
				}

				await emit('metrics', {
					model: routedModel,
					tokensIn: promptTokens,
					tokensOut: completionTokens,
					reasoningTokens,
					ttftMs,
					totalMs,
					tokensPerSec,
					cost: parseFloat(messageCost),
					modelSelection,
				})
				await emit('done', { messageId: assistantMessage.id })
				if (clientConnected) {
					controller.close()
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Failed to stream response'
				await updateRun({
					state: 'failed',
					label: 'Failed',
					error: errorMessage,
					finished: true,
				})
				await emit('done', {
					error: errorMessage,
				})
				if (clientConnected) {
					controller.close()
				}
			}
		},
	})

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	})
}
