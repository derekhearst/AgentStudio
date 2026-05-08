import { and, asc, eq, lte } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations } from '$lib/automations/automation.schema'
import { checkBudgetLimits, recordBudgetAlert, type BudgetLimitRow } from '$lib/costs/budget.server'
import { logger } from '$lib/observability/logger'
import { computeNextRunAt } from './cron'
import { getOrCreateAutomationConversation } from './conversation-utils.server'
import { runMaintenanceModeAutomation } from './maintenance-mode.server'
import { runChatFollowupAutomation } from './chat-followup-mode.server'

export { computeNextRunAt } from './cron'

/**
 * Wave 4 #17 phase 5 — public entry point for the automation_run job handler.
 * Looks up the automation by id, dispatches per-mode, then updates last_run_at /
 * next_run_at on the automation row. Throws if the automation is missing or disabled
 * (the job marks failed and won't retry past maxAttempts).
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
		let result:
			| { conversationId: string; runId?: string }
			| { conversationId: string | null; researchId?: string; jobId?: string; mode?: string }
			| { mode: 'maintenance'; summary: string; conversationId: null }
		if (automation.mode === 'research') {
			result = await runResearchModeAutomation(automation)
		} else if (automation.mode === 'maintenance') {
			result = await runMaintenanceModeAutomation(automation, now)
		} else {
			result = await runChatFollowupAutomation(automation, now)
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
