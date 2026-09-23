import { and, asc, eq, lte } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations, type AutomationRunTrigger } from '$lib/automations/automation.schema'
import { checkBudgetLimits, recordBudgetAlert, type BudgetLimitRow } from '$lib/costs/budget.server'
import { logger } from '$lib/observability/logger'
import { computeNextRunAt } from './cron'
import { getOrCreateAutomationConversation } from './conversation-utils.server'
import { runMaintenanceModeAutomation } from './maintenance-mode.server'
import { runChatFollowupAutomation } from './chat-followup-mode.server'
import {
	finishAutomationRun,
	resetAutomationFailureState,
	startAutomationRun,
} from './automation-runs.server'

export { computeNextRunAt } from './cron'

/**
 * #31 — knobs the caller sets per invocation. Defaults reproduce the pre-#31 behaviour of
 * a scheduled tick, so existing callers (`runAutomationById(id)`) are unchanged.
 */
export type RunAutomationOptions = {
	/** Who asked for this run. Recorded on the ledger row; also picks the defaults below. */
	trigger?: AutomationRunTrigger
	/** 1-based attempt number within the current tick. >1 means this is a retry. */
	attempt?: number
	/** The `automation_run` job this execution belongs to, for cross-linking. */
	jobId?: string | null
	/**
	 * Leave `next_run_at` exactly as it is. "Run now" must not move the schedule — pressing
	 * the button at 09:58 should not push a 10:00 tick to tomorrow. Defaults to true for
	 * manual runs, false for scheduled ones.
	 */
	preserveSchedule?: boolean
	/**
	 * Execute even when the row is disabled. Manual runs default to true so an operator can
	 * verify a fix on an automation that the failure policy switched off.
	 */
	allowDisabled?: boolean
}

/**
 * The common shape the per-mode handlers report back. Each mode fills in the parts it has:
 * chat_followup has a conversation (and a chat_run when an agent is attached), research has
 * a research id, maintenance has a summary. The ledger reads whichever are present.
 */
export type AutomationModeResult = {
	conversationId: string | null
	runId?: string
	researchId?: string
	jobId?: string
	mode?: string
	summary?: string
	/** Text to excerpt into the run row so the history shows what came out. */
	output?: string | null
	/** Dollar cost of the run as reported by the cost ledger, when the mode knows it. */
	costUsd?: string | null
}

/**
 * Wave 4 #17 phase 5 — public entry point for the automation_run job handler.
 * Looks up the automation by id, dispatches per-mode, then updates last_run_at /
 * next_run_at on the automation row. Throws if the automation is missing or disabled
 * (the job marks failed and won't retry past maxAttempts).
 *
 * #31 — every invocation also opens a row in the `automation_runs` ledger and closes it
 * with the outcome, so the /automations page can show whether past runs actually worked
 * and link to what they produced.
 */
export async function runAutomationById(
	automationId: string,
	now = new Date(),
	options: RunAutomationOptions = {},
) {
	const trigger: AutomationRunTrigger = options.trigger ?? 'schedule'
	const attempt = Math.max(1, Math.floor(options.attempt ?? 1))
	const preserveSchedule = options.preserveSchedule ?? trigger === 'manual'
	const allowDisabled = options.allowDisabled ?? trigger === 'manual'

	const [automation] = await db.select().from(automations).where(eq(automations.id, automationId)).limit(1)
	if (!automation) {
		throw new Error(`Automation ${automationId} not found`)
	}
	if (!automation.enabled && !allowDisabled) {
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
		return await handleAutomationBudgetBlocked(automation, budgetCheck.blockedBy, now, {
			trigger,
			attempt,
			jobId: options.jobId ?? null,
		})
	}

	// #31 — ledger row opens here, so a run that dies mid-flight still leaves a trace.
	const ledgerRun = await startAutomationRun({
		automationId: automation.id,
		userId: automation.userId,
		mode: automation.mode,
		trigger,
		attempt,
		jobId: options.jobId ?? null,
		startedAt: now,
	})

	// Wave 5 #21 phase 4 — per-mode dispatch.
	const startedAt = Date.now()
	let success = true
	try {
		let result: AutomationModeResult
		if (automation.mode === 'research') {
			result = await runResearchModeAutomation(automation)
		} else if (automation.mode === 'maintenance') {
			result = await runMaintenanceModeAutomation(automation, now)
		} else {
			result = await runChatFollowupAutomation(automation, now)
		}

		// "Run now" must not disturb the schedule — only a scheduled tick advances it.
		const nextRunAt = preserveSchedule
			? automation.nextRunAt
			: computeNextRunAt(automation.cronExpression, now, automation.timezone)
		await db
			.update(automations)
			.set(
				preserveSchedule
					? { lastRunAt: now, updatedAt: now }
					: { lastRunAt: now, nextRunAt, updatedAt: now },
			)
			.where(eq(automations.id, automation.id))

		await finishAutomationRun(ledgerRun?.id, {
			status: 'completed',
			conversationId: result.conversationId ?? null,
			chatRunId: 'runId' in result ? (result.runId ?? null) : null,
			researchId: 'researchId' in result ? (result.researchId ?? null) : null,
			costUsd: 'costUsd' in result ? (result.costUsd ?? null) : null,
			output: 'output' in result ? result.output : 'summary' in result ? result.summary : null,
			finishedAt: new Date(),
		})
		// A run that worked ends the failure streak — and un-stamps a disabled-by-failure
		// row, so a manual verification run leaves the card honest.
		await resetAutomationFailureState(automation.id)

		return { ...result, nextRunAt: nextRunAt?.toISOString() ?? null }
	} catch (err) {
		success = false
		await finishAutomationRun(ledgerRun?.id, {
			status: 'failed',
			error: err instanceof Error ? err.message : String(err),
			finishedAt: new Date(),
		})
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
	context: { trigger: AutomationRunTrigger; attempt: number; jobId: string | null },
) {
	// #31 — a blocked tick is part of the run history too, with its own status so it is not
	// confused with a failure (nothing is broken; a cap was hit).
	const ledgerRun = await startAutomationRun({
		automationId: automation.id,
		userId: automation.userId,
		mode: automation.mode,
		trigger: context.trigger,
		attempt: context.attempt,
		jobId: context.jobId,
		startedAt: now,
	})
	await finishAutomationRun(ledgerRun?.id, {
		status: 'blocked',
		error: `Budget block: ${blockedBy.scope} ${blockedBy.period} limit of $${blockedBy.limitUsd}`,
		finishedAt: now,
	})

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
		nextRunAt = computeNextRunAt(automation.cronExpression, now, automation.timezone)
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
		// One job per research row, which this call has just created. Not the schedule slot:
		// "Run now" leaves `nextRunAt` alone, so a slot-derived key made the manual run and the
		// next scheduled tick compute the same key, and the tick's research row was linked to
		// the manual run's finished job and never executed. Which slot a run belongs to is
		// settled upstream, by the automation_run job's own key.
		dedupeKey: `automation_research:${research.id}`,
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

	const enqueued: Array<{
		automationId: string
		jobId?: string
		/** False when this slot already had its job — the tick found nothing new to queue. */
		created?: boolean
		/** Set when the slot was skipped instead of run; says why. */
		skipped?: string
		error?: string
	}> = []
	if (due.length > 0) {
		const { enqueueJobWithOutcome } = await import('$lib/jobs/jobs.server')
		for (const automation of due) {
			try {
				// One job per scheduled slot, EVER — hence `forever`. The slot stays due until the
				// run succeeds or its retry chain gives up, and both of those roll `nextRunAt`
				// forward. In between, every minute's tick lands here again: a failed first
				// attempt has already completed its job (the handler swallows the error and
				// queues its own retry), so a key that only covered active jobs would start a
				// fresh attempt-1 chain every minute alongside the retries.
				const dedupeKey = `automation:${automation.id}:${(automation.nextRunAt ?? now).toISOString().slice(0, 16)}`
				const { job, created } = await enqueueJobWithOutcome({
					type: 'automation_run',
					queue: 'default',
					priority: 50, // background tier — same as memory_mine
					dedupeKey,
					dedupeScope: 'forever',
					payload: { automationId: automation.id },
					userId: automation.userId,
				})
				if (!created && (job.status === 'failed' || job.status === 'canceled')) {
					// The queue gave up on this slot's job before the handler's own failure path
					// could run — a worker that kept dying mid-run, or a cancel from
					// /settings/jobs — so nothing rolled the schedule forward. Skip the slot the
					// way an exhausted retry chain does; otherwise the automation stays due and
					// every tick finds the same dead job for good.
					await skipScheduledSlot(automation, now)
					enqueued.push({ automationId: automation.id, jobId: job.id, created, skipped: `slot job ${job.status}` })
					continue
				}
				enqueued.push({ automationId: automation.id, jobId: job.id, created })
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

/** Roll `nextRunAt` past a slot that will never run. `lastRunAt` is untouched — nothing ran. */
async function skipScheduledSlot(automation: typeof automations.$inferSelect, now: Date): Promise<void> {
	let nextRunAt: Date
	try {
		nextRunAt = computeNextRunAt(automation.cronExpression, now, automation.timezone)
	} catch (err) {
		// A cron expression that no longer parses cannot be advanced; the automation's edit
		// form is where that gets fixed.
		logger.warn('[automations] could not skip a dead slot: bad cron expression', {
			automationId: automation.id,
			error: err instanceof Error ? err.message : String(err),
		})
		return
	}
	await db
		.update(automations)
		.set({ nextRunAt, updatedAt: now })
		.where(eq(automations.id, automation.id))
	logger.warn('[automations] skipped a slot whose job the queue gave up on', {
		automationId: automation.id,
		slot: automation.nextRunAt?.toISOString() ?? null,
		nextRunAt: nextRunAt.toISOString(),
	})
}
