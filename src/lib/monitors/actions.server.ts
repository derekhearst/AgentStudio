import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/sessions/sessions.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import { insertMessageWithSequence } from '$lib/chat/insert-message.server'
import { logger } from '$lib/observability/logger'
import type { MonitorRow } from './monitors.schema'
import { findOwnedAutomation } from './monitors.server'
import { describeCondition, monitorConditionSchema, type MonitorObservation } from './condition'

/**
 * #33 — what happens on the firing edge.
 *
 * Four actions, one contract: never throw at the caller. A monitor that fired has observed
 * something real, and losing that observation because a push endpoint was down or an agent
 * run crashed would be the worst possible failure mode. Every action reports
 * `{ ok, detail }`, and `runMonitorCheck` records the outcome on the row; a failed action
 * also falls back to a review item so the signal reaches a human either way.
 */

export type MonitorFireResult = {
	kind: MonitorRow['action']
	ok: boolean
	detail: Record<string, unknown>
}

export async function dispatchMonitorAction(
	monitor: MonitorRow,
	observation: MonitorObservation,
	now = new Date(),
): Promise<MonitorFireResult> {
	try {
		switch (monitor.action) {
			case 'review_item':
				return await fireReviewItem(monitor, observation)
			case 'push':
				return await firePush(monitor, observation)
			case 'run_automation':
				return await fireAutomation(monitor, observation)
			case 'start_conversation':
				return await fireConversation(monitor, observation, now)
			default: {
				const exhaustive: never = monitor.action
				throw new Error(`unknown monitor action: ${String(exhaustive)}`)
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		logger.warn('[monitors] action dispatch failed', { monitorId: monitor.id, action: monitor.action, message })
		// Fallback so a fired monitor is never silently swallowed.
		await openMonitorReviewItem(monitor, observation, {
			severity: 'critical',
			summaryPrefix: `Monitor "${monitor.name}" fired but its ${monitor.action} action failed`,
			extraPayload: { actionError: message },
		}).catch(() => null)
		return { kind: monitor.action, ok: false, detail: { error: message, fellBackTo: 'review_item' } }
	}
}

/** Human-readable context every action shares. */
function fireSummary(monitor: MonitorRow, observation: MonitorObservation): string {
	let watching = 'its condition'
	try {
		watching = describeCondition(monitorConditionSchema.parse(monitor.condition))
	} catch {
		// A stored condition that no longer parses should not stop the notification.
	}
	const detail = observation.note ?? observation.value.slice(0, 160)
	return `Monitor "${monitor.name}" fired — ${watching}. ${detail}`.slice(0, 500)
}

// ─────────── review_item ───────────

async function openMonitorReviewItem(
	monitor: MonitorRow,
	observation: MonitorObservation,
	options: {
		severity?: 'info' | 'warning' | 'critical'
		summaryPrefix?: string
		extraPayload?: Record<string, unknown>
	} = {},
) {
	const { openReviewItem } = await import('$lib/observability/review.server')
	return openReviewItem({
		type: 'monitor_fired',
		severity: options.severity ?? monitor.actionConfig.severity ?? 'warning',
		summary: options.summaryPrefix
			? `${options.summaryPrefix}: ${observation.note ?? observation.value.slice(0, 120)}`.slice(0, 500)
			: (monitor.actionConfig.title ?? fireSummary(monitor, observation)),
		payload: {
			monitorId: monitor.id,
			monitorName: monitor.name,
			conditionKind: monitor.conditionKind,
			condition: monitor.condition,
			observation,
			...(options.extraPayload ?? {}),
		},
		// One row per firing edge, not per check — `fireCount` has already been incremented
		// by the caller, so a retried job reuses the same key instead of stacking rows.
		dedupeKey: `monitor:${monitor.id}:${monitor.fireCount}`,
	})
}

async function fireReviewItem(monitor: MonitorRow, observation: MonitorObservation): Promise<MonitorFireResult> {
	const item = await openMonitorReviewItem(monitor, observation)
	return { kind: 'review_item', ok: item !== null, detail: { reviewItemId: item?.id ?? null } }
}

// ─────────── push ───────────

async function firePush(monitor: MonitorRow, observation: MonitorObservation): Promise<MonitorFireResult> {
	const { notifyUser } = await import('$lib/notifications/notify.server')
	const payload = {
		title: monitor.actionConfig.title ?? `Monitor: ${monitor.name}`,
		body: (monitor.actionConfig.body ?? observation.note ?? observation.value).slice(0, 400),
		url: monitor.actionConfig.url ?? '/monitors',
		tag: `monitor-${monitor.id}`,
	}
	// No category: sending a push *is* this monitor's action, which the user chose when they
	// set it up, so the Settings toggles do not mute it. The in-app row is the durable half;
	// web push is best-effort, and an unconfigured VAPID key must not turn a real observation
	// into a failed action.
	const result = await notifyUser({ userId: monitor.userId, category: null, payload })
	const notificationId = result.sent ? result.notificationId : null
	const delivered = result.sent ? result.delivered : 0
	const pushError = result.sent ? result.pushError : undefined
	return {
		kind: 'push',
		ok: notificationId !== null,
		detail: { notificationId, delivered, ...(pushError ? { pushError } : {}) },
	}
}

// ─────────── run_automation ───────────

/**
 * The `automation_run` job a monitor enqueues.
 *
 * `trigger: 'monitor'` because an event, not the schedule, asked for this run. Without a
 * trigger the handler treated it as a scheduled tick, and every firing moved the
 * automation's `nextRunAt`. It is not a manual run either: "Run now" may run a switched-off
 * automation and does not escalate failures, because a person is watching. Nobody watches a
 * monitor, so a monitor-fired run respects the off switch and reports its failures like a
 * scheduled one, and leaves the schedule alone like a manual one. See
 * `automationTriggerPolicy` in the automations domain.
 */
export function monitorAutomationJob(monitor: Pick<MonitorRow, 'id' | 'userId' | 'fireCount'>, automationId: string) {
	return {
		type: 'automation_run',
		queue: 'default',
		priority: 60,
		payload: { automationId, attempt: 1, trigger: 'monitor' as const },
		userId: monitor.userId,
		dedupeKey: `monitor_fire:${monitor.id}:${monitor.fireCount}`,
	}
}

async function fireAutomation(monitor: MonitorRow, observation: MonitorObservation): Promise<MonitorFireResult> {
	const automationId = monitor.actionConfig.automationId
	if (!automationId) throw new Error('actionConfig.automationId is missing')
	// Re-checked at fire time, not only when the monitor was saved: the automation may have
	// been deleted since. The job handler runs an automation as its own owner, so this is the
	// last point where "whose automation is this" can be asked.
	const automation = await findOwnedAutomation(monitor.userId, automationId)
	if (!automation) {
		throw new Error(`automation ${automationId} not found for this monitor's owner`)
	}
	// Switched off by its owner, or by the failure policy after repeated failures: either way
	// it must not run unattended. Refusing here (rather than letting the job fail) turns it into
	// one review item for this firing instead of a retry chain against a disabled automation.
	if (!automation.enabled) {
		throw new Error(`automation ${automationId} is switched off, so the monitor did not run it`)
	}
	const { enqueueJob } = await import('$lib/jobs/jobs.server')
	// Enqueued by job type rather than by importing the automations engine — the monitor
	// domain stays decoupled from whatever that engine looks like, and the job queue already
	// owns retries and forensics for the run.
	const job = await enqueueJob(monitorAutomationJob(monitor, automationId))
	return { kind: 'run_automation', ok: true, detail: { automationId, jobId: job.id, observed: observation.hash } }
}

// ─────────── start_conversation ───────────

/**
 * Open a conversation seeded with the configured prompt plus what the monitor saw, then run
 * the agent loop detached (no SSE consumer — the operator finds the conversation waiting for
 * them). The run is recorded with `source: 'automation'`, the existing enum value for
 * "scheduled, non-interactive"; the `label` says it came from a monitor.
 */
async function fireConversation(
	monitor: MonitorRow,
	observation: MonitorObservation,
	now: Date,
): Promise<MonitorFireResult> {
	const prompt = monitor.actionConfig.prompt?.trim()
	if (!prompt) throw new Error('actionConfig.prompt is missing')

	const { resolveDefaultAgentId } = await import('$lib/chat/agent-switch.server')
	const agentId = await resolveDefaultAgentId(monitor.userId, monitor.actionConfig.agentId ?? monitor.agentId)
	if (!agentId) throw new Error('no default agent configured — re-run database bootstrap to seed built-in agents')

	const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
	if (!agent) throw new Error(`agent ${agentId} not found`)

	const { getOrCreateSettings } = await import('$lib/settings/settings.server')
	const settings = await getOrCreateSettings(monitor.userId)
	const model = agent.model ?? settings.defaultModel

	const [conversation] = await db
		.insert(conversations)
		.values({
			title: `Monitor: ${monitor.name}`.slice(0, 200),
			userId: monitor.userId,
			agentId: agent.id,
			model,
		})
		.returning()

	const seeded = [
		prompt,
		'',
		'--- what the monitor observed ---',
		`Monitor: ${monitor.name}`,
		`Observed at: ${observation.observedAt}`,
		observation.note ? `Verdict: ${observation.note}` : null,
		'Value:',
		observation.value.slice(0, 4_000),
	]
		.filter((line) => line !== null)
		.join('\n')

	await insertMessageWithSequence({ conversationId: conversation.id, role: 'user', content: seeded, model })

	const { buildAgentDefinition, createDetachedSession, runChatLoop } = await import('$lib/runtime')
	const definition = await buildAgentDefinition({
		agent,
		userId: monitor.userId,
		intent: prompt,
		toolPolicy: [
			'Monitor policy:',
			'- A long-running monitor fired and woke you; there is no user watching in real time.',
			'- Act on what the monitor observed, then summarize what you did and what you recommend.',
			'- If you need a decision from the operator, state it plainly at the end instead of asking a question.',
		].join('\n'),
	})

	const [run] = await db
		.insert(chatRuns)
		.values({
			conversationId: conversation.id,
			userId: monitor.userId,
			agentId: agent.id,
			state: 'running',
			source: 'automation',
			label: `Monitor fired: ${monitor.name.slice(0, 80)}`,
			startedAt: now,
			lastHeartbeatAt: now,
		})
		.returning({ id: chatRuns.id })

	const session = createDetachedSession({ runId: run.id })
	try {
		const loopResult = await runChatLoop({
			session,
			userId: monitor.userId,
			conversationId: conversation.id,
			model,
			initialMessages: [
				{ role: 'system', content: definition.systemPrompt },
				{ role: 'user', content: seeded },
			],
			initialTools: definition.tools,
			computeTools: async () => definition.tools,
			// Bounded — nobody is here to course-correct a runaway.
			maxRounds: 10,
			approvalRequiredTools: new Set<string>(),
			isOrchestrator: false,
			agentId: agent.id,
			persistentKey: definition.persistentKey,
			worktree: definition.worktree,
			projectId: conversation.projectId ?? null,
			spawnSubagent: undefined,
		})

		const { logLlmUsage } = await import('$lib/costs/usage')
		const cost = await logLlmUsage({
			source: 'monitor',
			model,
			tokensIn: loopResult.promptTokens,
			tokensOut: loopResult.completionTokens,
			userId: monitor.userId,
			runId: run.id,
			agentId: agent.id,
			metadata: { monitorId: monitor.id, conversationId: conversation.id },
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
				monitorId: monitor.id,
				runId: run.id,
			},
		})

		await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversation.id))
		await session.updateRun({
			state: 'completed',
			label: 'Monitor conversation completed',
			lastDelta: loopResult.finalText.slice(-500),
			heartbeat: true,
			finished: true,
		})
		return {
			kind: 'start_conversation',
			ok: true,
			detail: { conversationId: conversation.id, runId: run.id },
		}
	} catch (err) {
		await session
			.updateRun({
				state: 'failed',
				label: 'Monitor conversation failed',
				error: err instanceof Error ? err.message : 'Monitor conversation failed',
				finished: true,
			})
			.catch(() => undefined)
		// The conversation row survives with the seeded prompt, so the observation is not lost
		// even though the agent loop died. Rethrow into the caller's review-item fallback.
		throw err
	}
}
