import { json, type RequestHandler } from '@sveltejs/kit'
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import { type LlmMessage } from '$lib/llm/chat.server'
import { generateTitle, estimateMessageTokens } from '$lib/chat/chat.server'
import { getContextWindowSize } from '$lib/tools/tools'
import { emitActivity } from '$lib/activity/activity.server'
import { logLlmUsage } from '$lib/costs/usage'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { persistRunBlocks } from '$lib/runs/blocks.server'
import {
	buildApprovalRequiredSet,
	buildBuiltinAgentPostureSlot,
	buildCacheableSystemPromptBlocks,
	buildIdentitySlot,
	buildLlmMessagesFromHistory,
	buildMemoryRecallSlot,
	buildProjectContextSlot,
	buildSkillSummariesText,
	buildToolPolicySlot,
	createToolComputer,
	enforceBudgetGuard,
	extractAgentWorkspaceConfig,
	maybeCompactConversation,
	resolveSkillTopK,
	trimToolResultsForRun,
	type CompactionStats,
} from '$lib/chat/stream-prep.server'
import { insertMessageWithSequence } from '$lib/chat/insert-message.server'
import { runInlineSubagent } from '$lib/agents/inline-subagent'
import { assembleSystemPrompt, applySlotOverrides, type ContextSlot } from '$lib/context/slots.server'
import { loadSlotOverrides } from '$lib/context/overrides.server'
import { resolveAgentToolPolicy } from '$lib/chat/agent-switch.server'
import { agents as agentsTable } from '$lib/agents/agents.schema'
import { runChatLoop, createSseSession } from '$lib/runtime'
import { encodeSseFrame } from '$lib/runtime/sse-codec'
import { logger } from '$lib/observability/logger'

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

const sse = encodeSseFrame

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

		const createdUser = await insertMessageWithSequence({
			conversationId: body.conversationId,
			role: 'user',
			content: body.content.trim(),
			model: routedModel,
			metadata: {},
			toolCalls: [],
			attachments: body.attachments ?? [],
		})

		parentMessageId = createdUser.id
	} else {
		const [lastUser] = await db
			.select()
			.from(messages)
			.where(and(eq(messages.conversationId, body.conversationId), eq(messages.role, 'user')))
			.orderBy(desc(messages.sequence))
			.limit(1)
		parentMessageId = lastUser?.id ?? null
	}

	const historyRows = await db
		.select({ role: messages.role, content: messages.content, attachments: messages.attachments })
		.from(messages)
		.where(eq(messages.conversationId, body.conversationId))
		.orderBy(asc(messages.sequence))

	// First exchange = only the message we just inserted exists (historyRows has exactly 1 row)
	const isFirstExchange = historyRows.length === 1 && !body.regenerate

	if (isFirstExchange) {
		void emitActivity('chat_started', `Chat started: ${conversation.title}`, {
			entityId: body.conversationId,
			entityType: 'conversation',
		})
	}

	const llmMessages: LlmMessage[] = buildLlmMessagesFromHistory(historyRows)

	// --- Context Engineering: Unified System Prompt ---
	const { approvalRequiredTools, programmaticToolCallingEnabled } =
		await buildApprovalRequiredSet(currentSettings)

	// Build skill summaries so the model can lazily load details with read_skill/read_skill_file.
	// Phase 4 of #4: filter by relevance to the user's query when available, capped to skillTopK
	// (default 8). Falls back to listing everything when no user content yet (e.g. regenerate
	// of a system-prompted run) or when embeddings are unavailable.
	const skillTopK = resolveSkillTopK(currentSettings)
	const skillSummariesText = await buildSkillSummariesText({
		userQuery: body.content,
		skillTopK,
	})

	const contextSlots: ContextSlot[] = []
	let scopedAgentTools: string[] | null = null
	let persistentKey: string | null = null
	let worktreeConfig: { repoPath: string; baseBranch?: string; deleteBranchOnCleanup?: boolean } | null = null

	// Resolve the bound agent — conversations are always logically bound to one (the modes
	// concept folded into agents) but the column is nullable at the DB layer for back-compat
	// with raw test fixtures. Fall back to the built-in Chat agent when null. Built-in agents
	// (chat / research / plan / autonomous) carry a `builtinKey` and drive the orchestrator
	// path; custom agents drive the per-agent path.
	let resolvedAgentId = conversation.agentId
	if (!resolvedAgentId) {
		const { getBuiltinAgentId } = await import('$lib/agents/builtin-agents.server')
		resolvedAgentId = await getBuiltinAgentId(db, 'chat')
		if (!resolvedAgentId) {
			return json({ error: 'No default agent configured. Re-run database bootstrap.' }, { status: 500 })
		}
	}
	const [agent] = await db
		.select()
		.from(agentsTable)
		.where(eq(agentsTable.id, resolvedAgentId))
		.limit(1)
	if (!agent) {
		return json({ error: 'Conversation agent not found' }, { status: 500 })
	}
	const agentToolPolicy = resolveAgentToolPolicy(agent.config as Parameters<typeof resolveAgentToolPolicy>[0])

	const isOrchestrator = agent.builtinKey != null

	// --- Context Engineering: Built-in Agent Posture ---
	const postureSlot = await buildBuiltinAgentPostureSlot(agent)
	if (postureSlot) contextSlots.push(postureSlot)

	// Wave 4 #15 phase 2 — project context slot when the conversation is bound to a project.
	const projectSlot = await buildProjectContextSlot({
		projectId: conversation.projectId,
		userId: user.id,
	})
	if (projectSlot) contextSlots.push(projectSlot)

	// --- Context Engineering: Orchestrator / Agent Identity ---
	contextSlots.push(await buildIdentitySlot(agent))
	if (!isOrchestrator) {
		const workspace = extractAgentWorkspaceConfig(agent.config)
		scopedAgentTools = workspace.scopedAgentTools
		persistentKey = workspace.persistentKey
		worktreeConfig = workspace.worktreeConfig
	}

	if (currentSettings.systemPrompt?.trim()) {
		// Reserved for optional future system prompt handling.
	}
	contextSlots.push(buildToolPolicySlot(isOrchestrator))
	if (skillSummariesText) {
		contextSlots.push({
			name: 'skills',
			priority: 70,
			content: `Available skills (use read_skill to load full content when relevant):\n${skillSummariesText}`,
			truncationStrategy: 'truncate-end',
		})
	}

	// --- Context Engineering: Memory Palace Recall ---
	const memorySlot = await buildMemoryRecallSlot({
		settings: currentSettings,
		userId: user.id,
		userQuery: body.content,
	})
	if (memorySlot) contextSlots.push(memorySlot)

	// Phase 8 of #4: per-(user, agent) slot overrides. Lets users disable slots, raise/lower
	// priority, or set per-slot token caps from /agents/[id]/settings (UI follow-up).
	const slotOverrides = await loadSlotOverrides(user.id, conversation.agentId)
	const overriddenSlots = applySlotOverrides(contextSlots, slotOverrides)
	const assembled = assembleSystemPrompt(overriddenSlots)
	const capabilityPrompt = assembled.systemPrompt

	// `cacheControl` (camelCase) matches the OpenRouter SDK input shape; the SDK
	// converts it to `cache_control` on the wire to Anthropic. Stable slots get the
	// marker so they cache across turns; volatile ones (memory/skills/companion_skills)
	// are appended without a marker so per-turn churn doesn't invalidate the prefix.
	const systemBlocks = buildCacheableSystemPromptBlocks({
		renderedSlots: assembled.renderedSlots,
		fallbackText: capabilityPrompt,
	})
	if (systemBlocks.length > 0) {
		llmMessages.unshift({ role: 'system', content: systemBlocks })
	}

	// --- Context Engineering: Conversation Compaction ---
	const compaction = await maybeCompactConversation({
		llmMessages,
		model: routedModel,
		userId: user.id,
	})
	const didCompact = compaction.didCompact
	const compactionStats: CompactionStats | null = compaction.stats
	const compactionTokensBefore = compaction.tokensBefore

	// --- Context Engineering: Trim Historical Tool Results ---
	const trimResult = trimToolResultsForRun({ messages: llmMessages, settings: currentSettings })
	const trimmedMessages = trimResult.messages
	const appliedEdits = trimResult.appliedEdits

	const startedAt = Date.now()

	// --- Context Engineering: Tool Loading (Tool Search Tool — deferred loading) ---
	const { loadedSearchableTools, computeTools } = createToolComputer({
		scopedAgentTools,
		isOrchestrator,
		programmaticToolCallingEnabled,
		agentToolPolicy,
		dreamingOnlyTools: DREAMING_ONLY_TOOLS,
	})
	const initialTools = computeTools()
	// No hard limit — loop exits when the model stops calling tools
	const MAX_TOOL_ROUNDS = 50

	// Phase 3 of #5: budget enforcement BEFORE creating the run row, so a `block` cap
	// short-circuits without leaving an orphan run.
	const budgetGuard = await enforceBudgetGuard({
		userId: user.id,
		agentId: conversation.agentId,
		conversationId: body.conversationId,
	})
	if (budgetGuard.blocked) {
		return json(budgetGuard.payload, { status: 402 })
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
		.returning({ id: chatRuns.id, evalRequired: chatRuns.evalRequired })

	const readable = new ReadableStream<Uint8Array>({
		async start(controller) {
			// Wave 2 #10 phase 1 — runtime extraction. The session wraps the controller +
			// run_events + chat_runs writes; the loop is now in $lib/runtime/loop.server.ts.
			const session = createSseSession({ runId: run.id, controller })

			try {
				// Notify client if compaction occurred. Include the full stats so the dev panel
				// can render before/after counts and the model used (Feature #6 telemetry).
				if (didCompact && compactionStats) {
					await session.emit('compaction', {
						tokensBefore: compactionTokensBefore,
						...compactionStats,
					})
				}

				// Phase 7 of #4: emit a context_stats snapshot so the chat workbench can show
				// the real prompt-assembly footprint (tokenizer-accurate) rather than estimating
				// client-side. Sent once at the top of the stream; cheap to compute.
				await session.emit('context_stats', {
					runId: run.id,
					tokenEstimate: estimateMessageTokens(trimmedMessages, routedModel),
					contextWindow: getContextWindowSize(routedModel),
					didCompact,
					includedSlots: assembled.includedSlots,
					droppedSlots: assembled.droppedSlots,
					truncatedSlots: assembled.truncatedSlots,
					systemPromptTokens: assembled.estimatedTokens,
					// Feature #5: applied_edits-style telemetry — what got trimmed before this turn
					appliedEdits,
				})

				// PDF input — switch on the file-parser plugin so OpenRouter routes the file
				// content blocks through Mistral OCR (default) or the model's native engine.
				// `pdf-text` is a good middle ground for text-only PDFs without paying the OCR cost.
				const hasPdfAttachment = trimmedMessages.some(
					(m) =>
						Array.isArray(m.content) &&
						m.content.some((b) => typeof b === 'object' && b !== null && 'type' in b && b.type === 'file'),
				)
				const chatPlugins = hasPdfAttachment
					? [{ id: 'file-parser' as const, pdf: { engine: 'pdf-text' as const } }]
					: undefined

				const loopResult = await runChatLoop({
					session,
					userId: user.id,
					conversationId: body.conversationId,
					model: routedModel,
					initialMessages: trimmedMessages,
					initialTools,
					reasoningConfig,
					chatPlugins,
					maxRounds: MAX_TOOL_ROUNDS,
					approvalRequiredTools,
					isOrchestrator,
					agentId: conversation.agentId ?? null,
					persistentKey,
					worktree: worktreeConfig,
					projectId: conversation.projectId ?? null,
					computeTools: async () => computeTools(),
					loadSearchableTools: (toolNames) => {
						for (const name of toolNames) loadedSearchableTools.add(name)
					},
					spawnSubagent: async (req) => {
						const fullTask = req.context ? `${req.context}\n\n${req.task}` : req.task
						const result = await runInlineSubagent(
							{ agentId: req.agentId, agentName: req.agentId.slice(0, 8), task: fullTask },
							user.id,
							body.conversationId,
							session.safeController,
						)
						return { conversationId: result.conversationId, result: result.result }
					},
				})

				const {
					promptTokens,
					completionTokens,
					reasoningTokens,
					cacheCreationInputTokens,
					cacheReadInputTokens,
					finalText: allTextContent,
					toolCalls: allToolCalls,
					streamBlocks,
				} = loopResult
				const firstTokenAt = loopResult.firstTokenAt

				const totalMs = Date.now() - startedAt
				const ttftMs = firstTokenAt
				const tokensPerSec = totalMs > 0 ? Math.round((completionTokens / (totalMs / 1000)) * 100) / 100 : null
				// Backfill the most recent thinking block with its final reasoning-token count.
				// The loop only learns the count from the LAST chunk; updating the block in-place
				// keeps the persisted metadata accurate after the message is saved.
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
					tokensCacheWrite: cacheCreationInputTokens,
					tokensCacheRead: cacheReadInputTokens,
					userId: user.id,
					runId: run.id,
					agentId: conversation.agentId ?? null,
					metadata: { conversationId: body.conversationId },
				})

				// Wrap the assistant insert (or partial-merge) and the conversation totals
				// update in a single transaction so a crash between leaves the row + totals
				// consistent. Title generation stays outside (it's a fire-and-forget side
				// effect started below).
				const finalMetadata = {
					modelSelection,
					reasoningEffort,
					reasoningTokens,
					tokensCacheWrite: cacheCreationInputTokens,
					tokensCacheRead: cacheReadInputTokens,
					runId: run.id,
					blocks: streamBlocks.length > 0 ? streamBlocks : undefined,
				}

				const assistantMessage = await db.transaction(async (tx) => {
					// Detect-and-merge: if `savePartialAssistant` wrote a partial row for this
					// run (network-blip recovery path), update it in place instead of inserting
					// a second assistant row for the same logical turn. Match by runId stamped
					// into metadata + the `partial` flag.
					const [existingPartial] = await tx
						.select({ id: messages.id })
						.from(messages)
						.where(
							and(
								eq(messages.conversationId, body.conversationId),
								eq(messages.role, 'assistant'),
								sql`${messages.metadata}->>'runId' = ${run.id}`,
								sql`${messages.metadata}->>'partial' = 'true'`,
							),
						)
						.limit(1)

					const written = existingPartial
						? (
								await tx
									.update(messages)
									.set({
										content: allTextContent || '(no output)',
										model: routedModel,
										parentMessageId,
										tokensIn: promptTokens,
										tokensOut: completionTokens,
										ttftMs,
										totalMs,
										tokensPerSec,
										cost: messageCost,
										metadata: finalMetadata,
										toolCalls: allToolCalls,
									})
									.where(eq(messages.id, existingPartial.id))
									.returning()
							)[0]
						: await insertMessageWithSequence(
								{
									conversationId: body.conversationId,
									role: 'assistant',
									content: allTextContent || '(no output)',
									model: routedModel,
									parentMessageId,
									tokensIn: promptTokens,
									tokensOut: completionTokens,
									ttftMs,
									totalMs,
									tokensPerSec,
									cost: messageCost,
									metadata: finalMetadata,
									toolCalls: allToolCalls,
								},
								tx,
							)

					await tx
						.update(conversations)
						.set({
							model: routedModel,
							totalTokens: conversation.totalTokens + promptTokens + completionTokens,
							totalCost: String(parseFloat(conversation.totalCost) + parseFloat(messageCost)),
							updatedAt: new Date(),
						})
						.where(eq(conversations.id, body.conversationId))

					return written
				})

				if (isFirstExchange && body.content) {
					const userContent = body.content.trim()
					void (async () => {
						try {
							const title = await generateTitle([
								{ role: 'user', content: userContent },
								{ role: 'assistant', content: allTextContent },
							])
							await db.update(conversations).set({ title }).where(eq(conversations.id, body.conversationId))
						} catch {
							// Non-critical — title stays as default
						}
					})()
				}

				await session.updateRun({
					state: 'completed',
					label: 'Completed',
					lastDelta: allTextContent.slice(-500),
					heartbeat: true,
					finished: true,
				})

				// --- Memory Palace: enqueue mining as a durable job ---
				// Wave 4 #17 phase 5: was a fire-and-forget `void mineConversation(...)`. Now
				// an enqueueJob with dedupeKey `mine:${conversationId}` so concurrent finishes
				// for the same convo collapse to one job, the work survives a restart, and
				// failures are visible in /settings/jobs instead of swallowed.
				const autoMine = (currentSettings.memoryConfig as { autoMine?: boolean } | null)?.autoMine !== false
				if (autoMine) {
					void (async () => {
						try {
							const { enqueueJob } = await import('$lib/jobs/jobs.server')
							await enqueueJob({
								type: 'memory_mine',
								queue: 'default',
								priority: 50, // background work — outranked by user-initiated jobs
								dedupeKey: `mine:${body.conversationId}`,
								payload: { conversationId: body.conversationId },
								userId: user.id,
								runId: run.id,
								sessionId: body.conversationId,
							})
						} catch (err) {
							logger.warn('[memory] enqueue mine job failed', { err })
						}
					})()
				}

				// Wave 4 #17 phase 5 — was a fire-and-forget `void runEvaluatorPass(...)`. Now an
				// enqueueJob with dedupeKey `eval:${runId}` so the work survives restart, fails
				// visibly in /settings/jobs, and dedupes if the trigger somehow fires twice. The
				// SSE `evaluation` event is dropped from this path — the verdict shows up in the
				// run viewer's Evaluations panel asynchronously when the worker finishes.
				if (run.evalRequired) {
					void (async () => {
						try {
							const { enqueueJob } = await import('$lib/jobs/jobs.server')
							const toolSummary = allToolCalls.length > 0
								? allToolCalls.map((c) => (c as { name?: string }).name).filter(Boolean).join(', ')
								: undefined
							await enqueueJob({
								type: 'evaluation_run',
								queue: 'default',
								priority: 75, // higher than memory_mine (50), lower than user-initiated (100+)
								dedupeKey: `eval:${run.id}`,
								payload: {
									runId: run.id,
									userId: user.id,
									conversationId: body.conversationId,
									taskDescription: body.content?.trim() ?? '(no user message)',
									generatorOutput: allTextContent,
									toolSummary,
								},
								userId: user.id,
								runId: run.id,
								sessionId: body.conversationId,
							})
						} catch (err) {
							logger.warn('[evaluations] enqueue evaluation_run job failed', { err })
						}
					})()
				}

				await session.emit('metrics', {
					model: routedModel,
					tokensIn: promptTokens,
					tokensOut: completionTokens,
					tokensCacheWrite: cacheCreationInputTokens,
					tokensCacheRead: cacheReadInputTokens,
					reasoningTokens,
					ttftMs,
					totalMs,
					tokensPerSec,
					cost: parseFloat(messageCost),
					modelSelection,
				})
				await session.emit('done', { messageId: assistantMessage.id })
				if (session.isClientConnected()) {
					controller.close()
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Failed to stream response'
				await session.updateRun({
					state: 'failed',
					label: 'Failed',
					error: errorMessage,
					finished: true,
				})
				await session.emit('done', {
					error: errorMessage,
				})
				if (session.isClientConnected()) {
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
