import { and, asc, eq, lte } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations } from '$lib/automations/automation.schema'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { agents } from '$lib/agents/agents.schema'
import { chat, type LlmMessage } from '$lib/llm/chat.server'
import { logLlmUsage } from '$lib/costs/usage'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { buildAgentDefinition, createDetachedSession, runChatLoop } from '$lib/runtime'
import { insertMessageWithSequence } from '$lib/chat/insert-message.server'
import { checkBudgetLimits, recordBudgetAlert, type BudgetLimitRow } from '$lib/costs/budget.server'
import { logger } from '$lib/observability/logger'
import { computeNextRunAt } from './cron'

export { computeNextRunAt } from './cron'

async function getOrCreateAutomationConversation(automation: typeof automations.$inferSelect) {
	if (automation.conversationMode === 'reuse' && automation.conversationId) {
		const [existing] = await db
			.select()
			.from(conversations)
			.where(and(eq(conversations.id, automation.conversationId), eq(conversations.userId, automation.userId)))
			.limit(1)
		if (existing) return existing
	}

	// Conversations require an agent (NOT NULL FK). Use the automation's bound agent if any,
	// otherwise fall back to the user's default agent (and ultimately the built-in Chat agent).
	const { resolveDefaultAgentId } = await import('$lib/chat/agent-switch.server')
	const agentId = await resolveDefaultAgentId(automation.userId, automation.agentId)
	if (!agentId) {
		throw new Error('No default agent configured. Re-run database bootstrap to seed built-in agents.')
	}
	const [created] = await db
		.insert(conversations)
		.values({
			title: automation.description,
			userId: automation.userId,
			agentId,
			model: 'anthropic/claude-sonnet-4',
		})
		.returning()

	if (automation.conversationMode === 'reuse') {
		await db
			.update(automations)
			.set({ conversationId: created.id, updatedAt: new Date() })
			.where(eq(automations.id, automation.id))
	}

	return created
}

/**
 * Wave 2 #10 phase 6 — when an agent is attached, the automation tick runs the FULL agent loop
 * (tool calls, multi-round, capability disclosure, durable run state) via the runtime + a
 * detached Session. Without an agent, we keep the legacy single-shot `chat()` synthesis path —
 * lighter, no wasted infra, no need for a chat_run row.
 */
/**
 * Wave 4 #17 phase 5 — public entry point for the automation_run job handler.
 * Looks up the automation by id, runs it via the existing runAutomation pipeline, then
 * updates last_run_at / next_run_at on the automation row. Throws if the automation is
 * missing or disabled (the job marks failed and won't retry past maxAttempts).
 */
export async function runAutomationById(automationId: string, now = new Date()) {
	const [automation] = await db.select().from(automations).where(eq(automations.id, automationId)).limit(1)
	if (!automation) {
		throw new Error(`Automation ${automationId} not found`)
	}
	if (!automation.enabled) {
		throw new Error(`Automation ${automationId} is disabled`)
	}

	// Wave 5 #21 phase 5 — budget pre-check. Skip the run + bump nextRunAt + open a review
	// item when an applicable cap is exceeded; the next scheduled tick can try again once the
	// period rolls or an operator lifts the cap. Mirrors the chat-stream policy_override_request
	// flow so the same /review surface covers both interactive and scheduled execution paths.
	const budgetCheck = await checkBudgetLimits({
		userId: automation.userId,
		agentId: automation.agentId ?? undefined,
	})
	if (!budgetCheck.allowed && budgetCheck.blockedBy) {
		return await handleAutomationBudgetBlocked(automation, budgetCheck.blockedBy, now)
	}

	// Wave 5 #21 phase 4 — per-mode dispatch.
	const startedAt = Date.now()
	let success = true
	try {
		let result: { conversationId: string; runId?: string } | { conversationId: string | null; researchId?: string; jobId?: string; mode?: string } | { mode: 'maintenance'; summary: string; conversationId: null }
		if (automation.mode === 'research') {
			result = await runResearchModeAutomation(automation)
		} else if (automation.mode === 'maintenance') {
			result = await runMaintenanceModeAutomation(automation, now)
		} else {
			result = await runAutomation(automation, now)
		}
		const nextRunAt = computeNextRunAt(automation.cronExpression, now)
		await db
			.update(automations)
			.set({ lastRunAt: now, nextRunAt, updatedAt: now })
			.where(eq(automations.id, automation.id))
		return { ...result, nextRunAt: nextRunAt?.toISOString() ?? null }
	} catch (err) {
		success = false
		throw err
	} finally {
		// Wave 5 #21 phase 3 + #20 phase 4 — emit per-mode lifecycle metric so /review/health
		// shows automation throughput broken out by mode + outputTarget. Best-effort dynamic
		// import keeps the engine free of an observability cycle.
		void (async () => {
			try {
				const { recordMetric } = await import('$lib/observability/metrics.server')
				const durationMs = Math.max(0, Date.now() - startedAt)
				await recordMetric({
					metric: 'automations.duration_ms',
					dimension: { mode: automation.mode, outputTarget: automation.outputTarget, status: success ? 'completed' : 'failed' },
					value: durationMs,
				})
				await recordMetric({
					metric: `automations.lifecycle.${success ? 'completed' : 'failed'}`,
					dimension: { mode: automation.mode, outputTarget: automation.outputTarget },
					value: 1,
				})
			} catch (err) {
				logger.warn('[automations] lifecycle metric failed (non-fatal)', { err })
			}
		})()
	}
}

/**
 * Wave 5 #21 phase 5 — budget block side-channel.
 *
 * Skips the scheduled run, persists a budget block alert (idempotent per period), opens a
 * `policy_override_request` review item so an operator can lift the cap or hold it, advances
 * the schedule so we don't immediately re-attempt on the next minute tick, and emits a
 * `blocked` lifecycle metric so /review/health distinguishes blocked from completed/failed
 * automations. Returns a marker shape parallel to the success path so callers can branch.
 */
async function handleAutomationBudgetBlocked(
	automation: typeof automations.$inferSelect,
	blockedBy: BudgetLimitRow,
	now: Date,
) {
	try {
		await recordBudgetAlert({
			limit: blockedBy,
			triggerType: 'block',
			spendUsd: parseFloat(blockedBy.limitUsd),
		})
	} catch (err) {
		logger.warn('[automations] budget block alert insert failed', { err })
	}

	void (async () => {
		try {
			const { openReviewItem } = await import('$lib/observability/review.server')
			await openReviewItem({
				type: 'policy_override_request',
				severity: 'warning',
				summary: `Automation budget block: ${blockedBy.scope} ${blockedBy.period} limit of $${blockedBy.limitUsd} blocked "${automation.description.slice(0, 80)}"`,
				payload: {
					kind: 'budget',
					source: 'automation',
					limitId: blockedBy.id,
					scope: blockedBy.scope,
					scopeId: blockedBy.scopeId,
					period: blockedBy.period,
					limitUsd: blockedBy.limitUsd,
					userId: automation.userId,
					automationId: automation.id,
					automationDescription: automation.description,
				},
				dedupeKey: `budget:${blockedBy.id}:${automation.userId}:${automation.id}`,
			})
		} catch (err) {
			logger.warn('[automations] policy_override_request open failed', { err })
		}
	})()

	let nextRunAt: Date | null = null
	try {
		nextRunAt = computeNextRunAt(automation.cronExpression, now)
	} catch {
		// Bad cron expression — leave nextRunAt unchanged so the dispatcher won't keep
		// re-evaluating; the same condition would re-trigger immediately otherwise.
	}
	await db
		.update(automations)
		.set({ lastRunAt: now, nextRunAt: nextRunAt ?? automation.nextRunAt, updatedAt: now })
		.where(eq(automations.id, automation.id))

	void (async () => {
		try {
			const { recordMetric } = await import('$lib/observability/metrics.server')
			await recordMetric({
				metric: 'automations.lifecycle.blocked',
				dimension: { mode: automation.mode, outputTarget: automation.outputTarget },
				value: 1,
			})
		} catch (err) {
			logger.warn('[automations] blocked lifecycle metric failed (non-fatal)', { err })
		}
	})()

	return {
		blocked: true as const,
		conversationId: null,
		runId: null,
		nextRunAt: nextRunAt?.toISOString() ?? null,
		blockedBy: {
			limitId: blockedBy.id,
			scope: blockedBy.scope,
			period: blockedBy.period,
			limitUsd: blockedBy.limitUsd,
		},
	}
}

/**
 * Wave 5 #21 phase 4 — research-mode dispatch.
 *
 * Instead of running the prompt as a chat reply, we open a `research` row carrying the
 * automation's prompt as the query and enqueue a `research_run` job. The Wave 4 #18
 * orchestrator picks it up: planner → sub-question fan-out → synthesizer → final report.
 * The conversation context (when reused) gets the research linked back via
 * `research.conversationId` so the user sees the resulting report alongside the chat
 * history when they next open it.
 *
 * Output routing (review_inbox, task, artifact targets) is intentionally NOT wired here —
 * those targets are layered downstream of the research_run completion event. The
 * automation lifecycle metric still emits with `mode='research'` so the dashboard
 * distinguishes research throughput from chat-followup throughput.
 */
async function runResearchModeAutomation(automation: typeof automations.$inferSelect) {
	const conversation = await getOrCreateAutomationConversation(automation)
	const { createResearch, updateResearch } = await import('$lib/research/research.server')
	const { enqueueJob } = await import('$lib/jobs/jobs.server')

	const research = await createResearch({
		userId: automation.userId,
		query: automation.prompt,
		conversationId: conversation.id,
	})
	const job = await enqueueJob({
		type: 'research_run',
		queue: 'default',
		// Background-tier — a scheduled research automation shouldn't preempt user-initiated
		// research runs (which use priority 150). 100 keeps it ahead of chat_followup ticks
		// (priority 50) without getting in the way of an interactive operator.
		priority: 100,
		payload: { researchId: research.id },
		userId: automation.userId,
		dedupeKey: `automation_research:${automation.id}:${(automation.nextRunAt ?? new Date()).toISOString().slice(0, 16)}`,
	})
	await updateResearch(research.id, { jobId: job.id })

	return {
		conversationId: conversation.id,
		researchId: research.id,
		jobId: job.id,
		mode: 'research' as const,
	}
}

/**
 * Wave 5 #21 phase 4 — maintenance-mode dispatch.
 *
 * Maintenance ticks are the "scheduled hygiene that doesn't belong in chat history" mode:
 * cleanup prompts, log digests, anything where filling up a conversation thread is noise.
 * Implementation: run the prompt as a single LLM synthesis call, log the cost ledger entry
 * for the run, and return a short summary marker. We intentionally don't insert
 * user/assistant messages into any conversation — operators inspect maintenance ticks via
 * `automations.lifecycle.<status>` metrics + `/automations` last-run timestamps, not chat.
 *
 * Output routing (review_inbox, task, artifact) is documented as a follow-up; the
 * minimum-viable maintenance dispatch ships here so operators can schedule low-noise work
 * today.
 */
async function runMaintenanceModeAutomation(
	automation: typeof automations.$inferSelect,
	now: Date,
) {
	const settings = await getOrCreateSettings(automation.userId)
	const model = settings.defaultModel

	const prompt = `Maintenance run at ${now.toISOString()}\n\n${automation.prompt}`
	const response = await chat([{ role: 'user', content: prompt }], model)

	void logLlmUsage({
		source: 'automation',
		model,
		tokensIn: response.usage?.promptTokens ?? 0,
		tokensOut: response.usage?.completionTokens ?? 0,
		userId: automation.userId,
		agentId: automation.agentId ?? null,
		metadata: { automationId: automation.id, mode: 'maintenance' },
	}).catch(() => {})

	const fullSummary = (response.content ?? '').trim()
	const route = await routeMaintenanceOutput(automation, fullSummary, model, now).catch((err) => {
		logger.warn('[automations] output routing failed (non-fatal)', { err })
		return { target: 'none' as const }
	})

	return {
		conversationId: route.target === 'chat_session' ? (route as { conversationId?: string }).conversationId ?? null : null,
		mode: 'maintenance' as const,
		summary: fullSummary.slice(0, 500),
		outputTarget: automation.outputTarget,
		routedTo: route.target,
		artifactId: 'artifactId' in route ? route.artifactId : null,
		reviewItemId: 'reviewItemId' in route ? route.reviewItemId : null,
	}
}

/**
 * Wave 5 #21 phase 4 (output routing) — maintenance-mode result destination.
 *
 * Each `outputTarget` enum value gets a destination:
 *   - `chat_session` (default): assistant message in the automation's conversation
 *   - `review_inbox`: `automation_summary` review item (deduped per-hour by automation id)
 *   - `artifact`: new versioned artifact in the conversation's bound project (skipped + logged
 *     with a clear marker if no project is bound, since artifacts require one)
 *
 * Best-effort: failures are caught at the caller so a routing hiccup never invalidates the
 * already-completed maintenance work.
 */
async function routeMaintenanceOutput(
	automation: typeof automations.$inferSelect,
	summary: string,
	model: string,
	now: Date,
): Promise<
	| { target: 'chat_session'; conversationId: string }
	| { target: 'review_inbox'; reviewItemId: string | null }
	| { target: 'artifact'; artifactId: string }
	| { target: 'artifact_skipped'; reason: string }
	| { target: 'none' }
> {
	const trimmed = summary.length > 0 ? summary : '(no output)'

	if (automation.outputTarget === 'review_inbox') {
		const { openReviewItem } = await import('$lib/observability/review.server')
		const item = await openReviewItem({
			type: 'automation_summary',
			severity: 'info',
			summary: `Maintenance: ${automation.description.slice(0, 100)}`,
			payload: {
				kind: 'maintenance_summary',
				automationId: automation.id,
				summary: trimmed.slice(0, 4000),
				mode: 'maintenance',
			},
			// One open item per automation per hour — back-to-back ticks within an hour
			// collapse to a single inbox row instead of flooding the queue.
			dedupeKey: `automation_summary:${automation.id}:${now.toISOString().slice(0, 13)}`,
		})
		return { target: 'review_inbox', reviewItemId: item?.id ?? null }
	}

	if (automation.outputTarget === 'artifact') {
		const conversation = await getOrCreateAutomationConversation(automation)
		if (!conversation.projectId) {
			logger.info('[automations] outputTarget=artifact but conversation has no project bound; skipping', {
				automationId: automation.id,
				conversationId: conversation.id,
			})
			return { target: 'artifact_skipped', reason: 'no project bound to automation conversation' }
		}
		const { createArtifact } = await import('$lib/projects/projects.server')
		const artifact = await createArtifact({
			projectId: conversation.projectId,
			name: `${automation.description.slice(0, 80)} (${now.toISOString().slice(0, 10)})`,
			contentType: 'markdown',
			content: trimmed,
			changeNote: `Maintenance run at ${now.toISOString()}`,
			editedBy: automation.userId,
		})
		return { target: 'artifact', artifactId: artifact.id }
	}

	// chat_session (default) — append the summary into the automation's conversation as
	// an assistant message. Differs from chat_followup mode because we don't insert the
	// user prompt; only the summary lands so the conversation isn't littered with the
	// "Maintenance run at …" header lines.
	const conversation = await getOrCreateAutomationConversation(automation)
	await insertMessageWithSequence({
		conversationId: conversation.id,
		role: 'assistant',
		content: trimmed,
		model,
		metadata: { source: 'automation_maintenance', automationId: automation.id, mode: 'maintenance' },
	})
	await db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, conversation.id))
	return { target: 'chat_session', conversationId: conversation.id }
}

async function runAutomation(automation: typeof automations.$inferSelect, now: Date) {
	const conversation = await getOrCreateAutomationConversation(automation)
	const [agent] = automation.agentId
		? await db.select().from(agents).where(eq(agents.id, automation.agentId)).limit(1)
		: [null]
	const settings = await getOrCreateSettings(automation.userId)
	const model = agent?.model ?? settings.defaultModel

	const history = await db
		.select({ role: messages.role, content: messages.content })
		.from(messages)
		.where(eq(messages.conversationId, conversation.id))
		.orderBy(asc(messages.sequence))
		.limit(12)

	const prompt = `Automation run at ${now.toISOString()}\n\n${automation.prompt}`
	await insertMessageWithSequence({
		conversationId: conversation.id,
		role: 'user',
		content: prompt,
		model,
	})

	if (agent) {
		return runAutomationWithAgent({ automation, conversation, agent, history, prompt, model, now })
	}
	return runAutomationSynthesis({ automation, conversation, history, prompt, model, now })
}

async function runAutomationSynthesis(args: {
	automation: typeof automations.$inferSelect
	conversation: typeof conversations.$inferSelect
	history: Array<{ role: string; content: string }>
	prompt: string
	model: string
	now: Date
}) {
	const { automation, conversation, history, prompt, model, now } = args

	const llmMessages: LlmMessage[] = []
	for (const item of history) {
		if (item.role === 'system' || item.role === 'user' || item.role === 'assistant') {
			llmMessages.push({ role: item.role, content: item.content })
		}
	}
	llmMessages.push({ role: 'user', content: prompt })

	const response = await chat(llmMessages, model)
	await insertMessageWithSequence({
		conversationId: conversation.id,
		role: 'assistant',
		content: response.content,
		model,
		tokensIn: response.usage?.promptTokens ?? 0,
		tokensOut: response.usage?.completionTokens ?? 0,
	})

	await db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, conversation.id))

	void logLlmUsage({
		source: 'agent_synthesis',
		model,
		tokensIn: response.usage?.promptTokens ?? 0,
		tokensOut: response.usage?.completionTokens ?? 0,
		userId: automation.userId,
		agentId: automation.agentId ?? null,
	}).catch(() => {})

	return { conversationId: conversation.id }
}

async function runAutomationWithAgent(args: {
	automation: typeof automations.$inferSelect
	conversation: typeof conversations.$inferSelect
	agent: typeof agents.$inferSelect
	history: Array<{ role: string; content: string }>
	prompt: string
	model: string
	now: Date
}) {
	const { automation, conversation, agent, history, prompt, model, now } = args

	// Wave 2 #10 phase 2 — slot assembly + workspace context resolved by the runtime.
	const definition = await buildAgentDefinition({
		agent,
		userId: automation.userId,
		intent: prompt,
		toolPolicy: [
			'Automation policy:',
			'- This is a scheduled automation tick — there is no user to ask in real time.',
			'- Complete the work, then summarize what you did. If you need user input, leave a clear note for the next manual review.',
		].join('\n'),
	})

	const llmMessages: LlmMessage[] = [{ role: 'system', content: definition.systemPrompt }]
	for (const item of history) {
		if (item.role === 'user' || item.role === 'assistant') {
			llmMessages.push({ role: item.role, content: item.content })
		}
	}
	llmMessages.push({ role: 'user', content: prompt })

	const [run] = await db
		.insert(chatRuns)
		.values({
			conversationId: conversation.id,
			userId: automation.userId,
			agentId: agent.id,
			state: 'running',
			source: 'automation',
			label: `Automation tick: ${automation.description.slice(0, 80)}`,
			startedAt: now,
			lastHeartbeatAt: now,
		})
		.returning({ id: chatRuns.id })

	const session = createDetachedSession({ runId: run.id })

	try {
		const loopResult = await runChatLoop({
			session,
			userId: automation.userId,
			conversationId: conversation.id,
			model,
			initialMessages: llmMessages,
			initialTools: definition.tools,
			computeTools: async () => definition.tools,
			maxRounds: 10, // automations are bounded — no human in the loop to course-correct
			approvalRequiredTools: new Set<string>(), // no approval surface in a detached run
			isOrchestrator: false,
			agentId: agent.id,
			persistentKey: definition.persistentKey,
			worktree: definition.worktree,
			projectId: conversation.projectId ?? null,
			spawnSubagent: undefined,
		})

		const cost = await logLlmUsage({
			source: 'automation',
			model,
			tokensIn: loopResult.promptTokens,
			tokensOut: loopResult.completionTokens,
			userId: automation.userId,
			runId: run.id,
			agentId: agent.id,
			metadata: { conversationId: conversation.id, automationId: automation.id },
		}).catch(() => '0')

		await insertMessageWithSequence({
			conversationId: conversation.id,
			role: 'assistant',
			content: loopResult.finalText || '(no output)',
			model,
			tokensIn: loopResult.promptTokens,
			tokensOut: loopResult.completionTokens,
			cost,
			toolCalls: loopResult.toolCalls,
			metadata: {
				blocks: loopResult.streamBlocks.length > 0 ? loopResult.streamBlocks : undefined,
				automationId: automation.id,
				runId: run.id,
			},
		})

		await db
			.update(conversations)
			.set({ updatedAt: now })
			.where(eq(conversations.id, conversation.id))

		await session.updateRun({
			state: 'completed',
			label: 'Automation completed',
			lastDelta: loopResult.finalText.slice(-500),
			heartbeat: true,
			finished: true,
		})

		return { conversationId: conversation.id, runId: run.id }
	} catch (error) {
		await session.updateRun({
			state: 'failed',
			label: 'Automation failed',
			error: error instanceof Error ? error.message : 'Automation run failed',
			finished: true,
		})
		throw error
	}
}

/**
 * Wave 4 #17 phase 5 — was an inline-execution pass. Now enqueues `automation_run` jobs for
 * each due automation; the worker picks them up + runs them durably. Benefits: ticks survive
 * restart, dedupe per-automation prevents double-execution, failures show up in /settings/jobs.
 *
 * Caller (cron route OR scheduled tick) just enqueues. The job worker handles execution.
 * `lastRunAt` / `nextRunAt` are updated by the job handler (`runAutomationById`) once the run
 * actually succeeds, so a queued job that hasn't run yet won't accidentally bump the schedule.
 */
export async function checkAndRunAutomations(now = new Date()) {
	const due = await db
		.select()
		.from(automations)
		.where(and(eq(automations.enabled, true), lte(automations.nextRunAt, now)))
		.orderBy(asc(automations.nextRunAt))
		.limit(25)

	const enqueued: Array<{ automationId: string; jobId?: string; error?: string }> = []
	if (due.length > 0) {
		const { enqueueJob } = await import('$lib/jobs/jobs.server')
		for (const automation of due) {
			try {
				// Dedupe key includes the next-run minute so back-to-back ticks within the same
				// minute collapse, but the next minute's tick gets a fresh enqueue if the job
				// is still pending (the worker will skip when it sees lastRunAt updated).
				const dedupeKey = `automation:${automation.id}:${(automation.nextRunAt ?? now).toISOString().slice(0, 16)}`
				const job = await enqueueJob({
					type: 'automation_run',
					queue: 'default',
					priority: 50, // background tier — same as memory_mine
					dedupeKey,
					payload: { automationId: automation.id },
					userId: automation.userId,
				})
				enqueued.push({ automationId: automation.id, jobId: job.id })
			} catch (error) {
				enqueued.push({
					automationId: automation.id,
					error: error instanceof Error ? error.message : 'Failed to enqueue automation_run',
				})
			}
		}
	}

	return {
		runAt: now.toISOString(),
		evaluated: due.length,
		enqueued,
	}
}
