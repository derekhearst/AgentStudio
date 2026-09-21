/**
 * Chat streaming endpoint, rebuilt on the Claude Agent SDK.
 *
 * What changed from the hand-written loop:
 *   - The agent loop, tool dispatch, tool disclosure, compaction and
 *     tool-result trimming are the SDK's now. All of that code is gone.
 *   - Conversation state lives in the SDK session (`conversations.sdkSessionId`),
 *     so a turn sends only the new user message and resumes. We no longer rebuild
 *     the whole history from `messages` on every request.
 *   - Claude runs go through the Claude Code CLI login (subscription, no
 *     per-token cost); everything else goes through an Anthropic-compatible
 *     gateway. `buildEngineOptions` picks per run.
 *
 * What deliberately did NOT change: the SSE wire contract, so the chat page and
 * `sse-consumer` are untouched. Persistence, budgets, titles and the follow-up
 * jobs are all still ours.
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { and, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations } from '$lib/sessions/sessions.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import { agents as agentsTable } from '$lib/agents/agents.schema'
import { emitActivity } from '$lib/activity/activity.server'
import { logLlmUsage } from '$lib/costs/usage'
import { persistRunBlocks } from '$lib/runs/blocks.server'
import { appendRunEvent } from '$lib/runs/events.server'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { getContextWindowSize } from '$lib/tools/tools'
import { encodeSseFrame } from '$lib/runtime/sse-codec'
import { assembleSystemPrompt, applySlotOverrides, type ContextSlot } from '$lib/context/slots.server'
import { loadSlotOverrides } from '$lib/context/overrides.server'
import { resolveAgentToolPolicy } from '$lib/chat/agent-tool-filter'
import { enqueuePendingApproval, awaitApprovalDecision } from '$lib/runs/approvals.server'
import { enqueuePendingQuestion, awaitQuestionAnswers } from '$lib/runs/questions.server'
import {
	buildApprovalRequiredSet,
	buildBuiltinAgentPostureSlot,
	buildIdentitySlot,
	buildMemoryRecallSlot,
	buildProjectContextSlot,
	buildSkillSummariesText,
	buildToolPolicySlot,
	enforceBudgetGuard,
	enqueueEvaluationJob,
	enqueueMemoryMineJob,
	extractAgentWorkspaceConfig,
	maybeGenerateTitle,
	persistAssistantMessage,
	resolveModelConfig,
	resolveParentMessage,
	resolveSkillTopK,
} from '$lib/chat/stream-prep.server'
import {
	buildEngineOptions,
	GatewayNotConfiguredError,
	isClaudeModel,
	resolveRunPermissionMode,
} from '$lib/engine/options.server'
import { runEngineStream } from '$lib/engine/stream.server'
import {
	formatAttachmentWarnings,
	prepareAttachmentPrompt,
	singleUserMessageStream,
	type ChatAttachment,
} from '$lib/engine/attachments.server'
import { createAttachmentIo } from '$lib/engine/attachment-io.server'
import { runInlineSubagent } from '$lib/agents/inline-subagent'
import { logger } from '$lib/observability/logger'

type StreamPayload = {
	conversationId: string
	content?: string
	model?: string
	reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
	regenerate?: boolean
	attachments?: ChatAttachment[]
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 })
	const user = locals.user

	const body = (await request.json()) as StreamPayload
	if (!body.conversationId) return json({ error: 'conversationId is required' }, { status: 400 })

	const [conversation] = await db
		.select()
		.from(conversations)
		.where(and(eq(conversations.id, body.conversationId), eq(conversations.userId, user.id)))
		.limit(1)

	if (!conversation) return json({ error: 'Conversation not found' }, { status: 404 })

	const currentSettings = await getOrCreateSettings(user.id)
	const { routedModel, reasoningEffort, modelSelection } = resolveModelConfig({
		body,
		settings: currentSettings,
	})

	const parentResult = await resolveParentMessage({
		conversationId: body.conversationId,
		body,
		model: routedModel,
	})
	if (!parentResult.ok) return json({ error: parentResult.error }, { status: 400 })
	const parentMessageId = parentResult.parentMessageId

	// A conversation with no SDK session yet is on its first exchange as far as the
	// engine is concerned, which is also when the title gets generated.
	const isFirstExchange = !conversation.sdkSessionId && !body.regenerate
	if (isFirstExchange) {
		void emitActivity('chat_started', `Chat started: ${conversation.title}`, {
			entityId: body.conversationId,
			entityType: 'conversation',
		})
	}

	// ── Agent resolution ───────────────────────────────────────────────────────
	let resolvedAgentId = conversation.agentId
	if (!resolvedAgentId) {
		const { getBuiltinAgentId } = await import('$lib/agents/builtin-agents.server')
		resolvedAgentId = await getBuiltinAgentId(db, 'chat')
		if (!resolvedAgentId) {
			return json({ error: 'No default agent configured. Re-run database bootstrap.' }, { status: 500 })
		}
	}
	const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, resolvedAgentId)).limit(1)
	if (!agent) return json({ error: 'Conversation agent not found' }, { status: 500 })

	const agentToolPolicy = resolveAgentToolPolicy(agent.config as Parameters<typeof resolveAgentToolPolicy>[0])
	const isOrchestrator = agent.builtinKey != null
	const workspaceConfig = isOrchestrator ? null : extractAgentWorkspaceConfig(agent.config)

	// ── Context slots → one system prompt ──────────────────────────────────────
	// The slot system stays: it's how identity, posture, project context and memory
	// recall get composed. Only the delivery changed — the SDK takes a string, so
	// there are no per-block cache markers to manage any more.
	const contextSlots: ContextSlot[] = []
	const postureSlot = await buildBuiltinAgentPostureSlot(agent)
	if (postureSlot) contextSlots.push(postureSlot)

	const projectSlot = await buildProjectContextSlot({
		projectId: conversation.projectId,
		userId: user.id,
	})
	if (projectSlot) contextSlots.push(projectSlot)

	contextSlots.push(await buildIdentitySlot(agent))
	contextSlots.push(buildToolPolicySlot(isOrchestrator))

	const skillSummariesText = await buildSkillSummariesText({
		userQuery: body.content,
		skillTopK: resolveSkillTopK(currentSettings),
	})
	if (skillSummariesText) {
		contextSlots.push({
			name: 'skills',
			priority: 70,
			content: `Available skills (use read_skill to load full content when relevant):\n${skillSummariesText}`,
			truncationStrategy: 'truncate-end',
		})
	}

	const memorySlot = await buildMemoryRecallSlot({
		settings: currentSettings,
		userId: user.id,
		userQuery: body.content,
	})
	if (memorySlot) contextSlots.push(memorySlot)

	const slotOverrides = await loadSlotOverrides(user.id, conversation.agentId)
	const assembled = assembleSystemPrompt(applySlotOverrides(contextSlots, slotOverrides))

	// ── Approval policy ────────────────────────────────────────────────────────
	const { approvalRequiredTools } = await buildApprovalRequiredSet(currentSettings)

	/*
	 * #19 — the conversation's permission mode composes with the per-tool settings above.
	 * `RUN_SOURCE` is a const because this endpoint only ever opens interactive runs; it is
	 * named so the bypass refusal below reads as the rule it is rather than a literal.
	 * bypassPermissions is downgraded to default on any other surface, exactly as
	 * `push_branch` refuses outside an interactive chat run.
	 */
	const RUN_SOURCE = 'chat_stream' as const
	const permission = resolveRunPermissionMode({
		requested: conversation.permissionMode,
		runSource: RUN_SOURCE,
	})
	if (permission.downgraded) {
		logger.warn('[chat/stream] permission mode downgraded', {
			conversationId: body.conversationId,
			requested: conversation.permissionMode,
			reason: permission.reason,
		})
	}

	// ── Budget guard, before the run row so a block leaves no orphan ───────────
	const budgetGuard = await enforceBudgetGuard({
		userId: user.id,
		agentId: conversation.agentId,
		conversationId: body.conversationId,
	})
	if (budgetGuard.blocked) return json(budgetGuard.payload, { status: 402 })

	const [run] = await db
		.insert(chatRuns)
		.values({
			conversationId: body.conversationId,
			userId: user.id,
			agentId: conversation.agentId,
			state: 'running',
			source: RUN_SOURCE,
			label: body.regenerate ? 'Regenerating response' : 'Generating response',
			startedAt: new Date(),
			lastHeartbeatAt: new Date(),
		})
		.returning({ id: chatRuns.id, evalRequired: chatRuns.evalRequired })

	const startedAt = Date.now()
	// An agent can narrow the tool surface two ways: an explicit scoped list on a
	// custom agent, or a readOnly policy. Unrestricted means "hand the model
	// everything", which the SDK expresses as omitting allowedTools entirely.
	const policyTools = agentToolPolicy.kind === 'readOnly' ? Array.from(agentToolPolicy.allow) : undefined
	const scopedTools = workspaceConfig?.scopedAgentTools ?? policyTools

	// The tool server is constructed before the stream opens, but ask_user needs to
	// push a frame, so the emitter is assigned once the stream starts.
	let emitFrame: ((event: string, payload: unknown) => Promise<void>) | null = null
	let askUserSeq = 0

	async function fulfilAskUser(questions: unknown[]): Promise<string> {
		askUserSeq += 1
		const token = `${run.id}:q${askUserSeq}`
		const normalized = (questions as Array<Record<string, unknown>>).map((q) => ({
			header: String(q.header ?? ''),
			question: String(q.question ?? ''),
			options: (q.options ?? []) as Array<{ label: string; description?: string; recommended?: boolean }>,
			allowFreeformInput: true,
		}))

		await enqueuePendingQuestion(
			run.id,
			{ token, questions: normalized, requestedAt: new Date().toISOString() },
			{ state: 'waiting_user_input', label: 'Waiting for your answer' },
		)

		await emitFrame?.('ask_user', { id: token, name: 'ask_user', token, questions: normalized })

		const answers = await awaitQuestionAnswers(run.id, token)

		await db
			.update(chatRuns)
			.set({ state: 'running', label: 'Generating response' })
			.where(eq(chatRuns.id, run.id))

		if (!answers) return 'The user did not answer in time.'
		return Object.entries(answers)
			.map(([header, answer]) => `${header}: ${answer}`)
			.join('\n')
	}

	/*
	 * Full agent dispatch. runInlineSubagent builds a forwarded session that
	 * persists to the sub-agent's own run_events and pushes translated
	 * `subagent_*` frames into this controller WITHOUT a seq, so they never
	 * disturb the parent's resume cursor.
	 */
	let streamController: ReadableStreamDefaultController<Uint8Array> | null = null

	async function fulfilSubagent(req: { task: string; context?: string; agentId?: string }): Promise<string> {
		if (!req.agentId) return 'run_subagent requires an agentId.'
		if (!streamController) return 'Subagent dispatch is unavailable outside an active stream.'
		const task = req.context ? `${req.context}\n\n${req.task}` : req.task
		try {
			const outcome = await runInlineSubagent(
				{ agentId: req.agentId, agentName: req.agentId.slice(0, 8), task },
				user.id,
				body.conversationId,
				streamController,
			)
			return outcome.result
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			logger.warn('[chat/stream] subagent failed', { runId: run.id, error: message })
			return `Subagent failed: ${message}`
		}
	}

	/*
	 * #36 — attachments used to be declared on the payload and then never read,
	 * so an uploaded screenshot reached the database and the composer but never
	 * the model. Images now ride as content blocks (which forces the SDK's
	 * streaming-input form), non-image files are staged into the same sandbox
	 * workspace the run's tools resolve, and anything undeliverable produces a
	 * warning the user actually sees instead of a silent drop.
	 */
	const preparedPrompt = await prepareAttachmentPrompt({
		text: body.content ?? '',
		attachments: body.attachments,
		availableTools: scopedTools ? new Set(scopedTools) : null,
		io: createAttachmentIo({
			userId: user.id,
			runId: run.id,
			persistentKey: workspaceConfig?.persistentKey ?? null,
			worktree: workspaceConfig?.worktreeConfig ?? null,
			projectId: conversation.projectId ?? null,
		}),
	})
	const attachmentNotice = formatAttachmentWarnings(preparedPrompt.warnings)
	if (preparedPrompt.warnings.length > 0) {
		logger.warn('[chat/stream] attachments not fully delivered', {
			runId: run.id,
			warnings: preparedPrompt.warnings,
		})
	}

	let engineOptions
	try {
		engineOptions = buildEngineOptions({
			model: routedModel,
			reasoningEffort,
			systemPrompt: assembled.systemPrompt,
			allowedTools: scopedTools,
			permissionMode: permission.mode,
			runSource: RUN_SOURCE,
			resumeSessionId: conversation.sdkSessionId ?? undefined,
			tools: {
				userId: user.id,
				runId: run.id,
				onAskUser: (questions) => fulfilAskUser(questions),
				onRunSubagent: (req) => fulfilSubagent(req),
				workspace: {
					persistentKey: workspaceConfig?.persistentKey ?? null,
					worktree: workspaceConfig?.worktreeConfig ?? null,
					projectId: conversation.projectId ?? null,
				},
			},
		})
	} catch (error) {
		const message = error instanceof GatewayNotConfiguredError ? error.message : 'Failed to configure model'
		await db.update(chatRuns).set({ state: 'failed', label: 'Failed', error: message }).where(eq(chatRuns.id, run.id))
		return json({ error: message }, { status: 400 })
	}

	const readable = new ReadableStream<Uint8Array>({
		async start(controller) {
			/*
			 * Sequence ids come from `chat_runs.nextEventSeq` via appendRunEvent —
			 * the same counter `stream/resume` replays against. `delta` and
			 * `reasoning` are far too frequent to persist and are deliberately sent
			 * with no `id:` at all, which the SSE consumer already handles, so they
			 * never move the resume cursor.
			 */
			const NON_PERSISTED = new Set(['delta', 'reasoning'])

			const emit = async (event: string, payload: unknown) => {
				if (NON_PERSISTED.has(event)) {
					controller.enqueue(encodeSseFrame(event, payload))
					return
				}
				let seq: number | undefined
				try {
					seq = await appendRunEvent(run.id, event, payload)
				} catch (error) {
					// A failed event write must not kill the stream; the frame still
					// reaches a connected client, it just won't be replayable.
					logger.warn('[chat/stream] failed to persist run event', {
						runId: run.id,
						event,
						error: error instanceof Error ? error.message : String(error),
					})
				}
				controller.enqueue(encodeSseFrame(event, payload, seq))
			}

			emitFrame = emit
			streamController = controller

			try {
				await emit('context_stats', {
					runId: run.id,
					tokenEstimate: assembled.estimatedTokens,
					contextWindow: getContextWindowSize(routedModel),
					didCompact: false, // the SDK compacts internally; see compact boundary messages
					includedSlots: assembled.includedSlots,
					droppedSlots: assembled.droppedSlots,
					truncatedSlots: assembled.truncatedSlots,
					systemPromptTokens: assembled.estimatedTokens,
					appliedEdits: [],
				})

				/*
				 * The chat page has no generic notice channel and is off-limits to
				 * this change, so an attachment warning goes out as the first text of
				 * the turn and is persisted with the assistant message below. That
				 * way it is visible live AND after a reload — the one thing the old
				 * behaviour never was.
				 */
				if (attachmentNotice) await emit('delta', { content: attachmentNotice })

				const summary = await runEngineStream(
					{
						prompt: preparedPrompt.content
							? singleUserMessageStream(preparedPrompt.content)
							: preparedPrompt.text,
						options: engineOptions,
						emit,
						onSessionId: (sessionId) => {
							// Persist immediately: if the run dies mid-turn we still want the
							// next turn to resume rather than silently start a new session.
							void db
								.update(conversations)
								.set({ sdkSessionId: sessionId, updatedAt: new Date() })
								.where(eq(conversations.id, body.conversationId))
								.catch((error) =>
									logger.warn('[chat/stream] failed to persist sdkSessionId', { error: String(error) }),
								)
						},
						// Settings-only view; `permissionMode` composes with it inside the engine's
						// `resolveToolGate`, which is what decides allow / ask / deny.
						requiresApproval: (name) =>
							approvalRequiredTools.has('*') || approvalRequiredTools.has(name),
						permissionMode: permission.mode,
						requestApproval:
							approvalRequiredTools.size > 0
								? async ({ id, name, input }) => {
										const token = `${run.id}:${id}`
										await enqueuePendingApproval(
											run.id,
											{ token, toolName: name, args: input, requestedAt: new Date().toISOString() },
											{ state: 'waiting_tool_approval', label: `Awaiting approval: ${name}` },
										)
										const approved = await awaitApprovalDecision(run.id, token)
										if (approved) {
											await db
												.update(chatRuns)
												.set({ state: 'running', label: 'Generating response' })
												.where(eq(chatRuns.id, run.id))
										}
										return approved ? { allow: true } : { allow: false, reason: 'Denied by user' }
									}
								: undefined,
				})

				// Fold the attachment notice into the persisted turn so the reloaded
				// message matches what the user watched stream in.
				if (attachmentNotice) {
					const first = summary.blocks[0]
					if (first && first.kind === 'text') first.content = `${attachmentNotice}${first.content}`
					else summary.blocks.unshift({ kind: 'text', content: attachmentNotice })
				}

				await persistRunBlocks(run.id, summary.blocks)

				const totalMs = Date.now() - startedAt
				const claudeRun = isClaudeModel(routedModel)
				const tokensPerSec =
					totalMs > 0 && summary.usage.outputTokens > 0
						? Math.round((summary.usage.outputTokens / (totalMs / 1000)) * 100) / 100
						: null

				// Subscription runs have no per-token price, so record tokens and force the
				// dollar figure to zero rather than inventing one from list pricing.
				const messageCost = await logLlmUsage({
					source: 'chat',
					model: routedModel,
					tokensIn: summary.usage.inputTokens,
					tokensOut: summary.usage.outputTokens,
					tokensCacheWrite: summary.usage.cacheCreationTokens,
					tokensCacheRead: summary.usage.cacheReadTokens,
					userId: user.id,
					runId: run.id,
					agentId: conversation.agentId ?? null,
					costOverride: claudeRun ? 0 : summary.usage.costUsd,
					metadata: { conversationId: body.conversationId, subscription: claudeRun },
				})

				const assistantMessage = await persistAssistantMessage({
					conversationId: body.conversationId,
					parentMessageId,
					model: routedModel,
					content: `${attachmentNotice}${summary.text || '(no output)'}`,
					promptTokens: summary.usage.inputTokens,
					completionTokens: summary.usage.outputTokens,
					ttftMs: summary.ttftMs,
					totalMs,
					tokensPerSec,
					cost: messageCost,
					metadata: {
						modelSelection,
						reasoningEffort,
						reasoningTokens: summary.reasoningTokens,
						tokensCacheWrite: summary.usage.cacheCreationTokens,
						tokensCacheRead: summary.usage.cacheReadTokens,
						runId: run.id,
						sdkSessionId: summary.sessionId,
						numTurns: summary.numTurns,
						blocks: summary.blocks.length > 0 ? summary.blocks : undefined,
						attachmentWarnings:
							preparedPrompt.warnings.length > 0 ? preparedPrompt.warnings : undefined,
					},
					toolCalls: [],
					runId: run.id,
					conversationTotals: {
						previousTokens: conversation.totalTokens,
						previousCost: conversation.totalCost,
					},
				})

				maybeGenerateTitle({
					isFirstExchange,
					userContent: body.content ?? '',
					assistantContent: summary.text,
					conversationId: body.conversationId,
				})

				await db
					.update(chatRuns)
					.set({
						state: summary.error ? 'failed' : 'completed',
						label: summary.error ? 'Failed' : 'Completed',
						error: summary.error,
						lastDelta: summary.text.slice(-500),
						lastHeartbeatAt: new Date(),
						finishedAt: new Date(),
					})
					.where(eq(chatRuns.id, run.id))

				enqueueMemoryMineJob({
					settings: currentSettings,
					conversationId: body.conversationId,
					userId: user.id,
					runId: run.id,
				})
				if (run.evalRequired) {
					enqueueEvaluationJob({
						runId: run.id,
						userId: user.id,
						conversationId: body.conversationId,
						userContent: body.content,
						assistantContent: summary.text,
						toolCalls: [],
					})
				}

				await emit('metrics', {
					model: routedModel,
					tokensIn: summary.usage.inputTokens,
					tokensOut: summary.usage.outputTokens,
					tokensCacheWrite: summary.usage.cacheCreationTokens,
					tokensCacheRead: summary.usage.cacheReadTokens,
					reasoningTokens: summary.reasoningTokens,
					ttftMs: summary.ttftMs,
					totalMs,
					tokensPerSec,
					cost: parseFloat(messageCost),
					modelSelection,
					subscription: claudeRun,
				})
				await emit('done', { messageId: assistantMessage.id, ...(summary.error ? { error: summary.error } : {}) })
				controller.close()
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Failed to stream response'
				logger.error('[chat/stream] run failed', { runId: run.id, error: errorMessage })
				await db
					.update(chatRuns)
					.set({ state: 'failed', label: 'Failed', error: errorMessage, finishedAt: new Date() })
					.where(eq(chatRuns.id, run.id))
				await emit('done', { error: errorMessage })
				controller.close()
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
