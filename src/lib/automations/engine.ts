import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations, type AutomationRunTrigger } from '$lib/automations/automation.schema'
import type { JobRow } from '$lib/jobs/jobs.schema'
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
import { automationTriggerPolicy } from './failure-policy'

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
	 * manual and monitor-fired runs, false for scheduled ones (`automationTriggerPolicy`).
	 */
	preserveSchedule?: boolean
	/**
	 * Execute even when the row is disabled. Manual runs default to true so an operator can
	 * verify a fix on an automation that the failure policy switched off. Monitor-fired runs
	 * do not: nobody is watching them, so the off switch has to hold.
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
 * The automation a job points at is gone, or was switched off after the job was queued.
 *
 * Not a failure of the automation: nothing ran, and nothing will go better on a retry. The
 * job handler reports it as skipped rather than feeding it to the retry policy, which would
 * otherwise queue more attempts, bump the failure streak and notify the user that an
 * automation they deliberately turned off "failed".
 */
export class AutomationUnavailableError extends Error {
	constructor(
		readonly automationId: string,
		readonly reason: 'not_found' | 'disabled',
	) {
		super(reason === 'not_found' ? `Automation ${automationId} not found` : `Automation ${automationId} is disabled`)
		this.name = 'AutomationUnavailableError'
	}
}

/**
 * Wave 4 #17 phase 5 — public entry point for the automation_run job handler.
 * Looks up the automation by id, dispatches per-mode, then updates last_run_at /
 * next_run_at on the automation row. Throws `AutomationUnavailableError` if the automation
 * is missing, or disabled and this trigger may not run a disabled one.
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
	const policy = automationTriggerPolicy(trigger)
	const preserveSchedule = options.preserveSchedule ?? policy.preserveSchedule
	const allowDisabled = options.allowDisabled ?? policy.allowDisabled

	const [automation] = await db.select().from(automations).where(eq(automations.id, automationId)).limit(1)
	if (!automation) {
		throw new AutomationUnavailableError(automationId, 'not_found')
	}
	if (!automation.enabled && !allowDisabled) {
		throw new AutomationUnavailableError(automationId, 'disabled')
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
			preserveSchedule,
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
	context: { trigger: AutomationRunTrigger; attempt: number; jobId: string | null; preserveSchedule: boolean },
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

	// Only the schedule's own tick moves the schedule — a blocked "Run now" or monitor firing
	// must not push the next scheduled run out, any more than a successful one does.
	let nextRunAt: Date | null = context.preserveSchedule ? automation.nextRunAt : null
	if (!context.preserveSchedule) {
		try {
			nextRunAt = computeNextRunAt(automation.cronExpression, now, automation.timezone)
		} catch {
			// Bad cron expression — leave nextRunAt unchanged so the dispatcher won't keep
			// re-evaluating; the same condition would re-trigger immediately otherwise.
		}
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
				if (!created) {
					// The slot already has its job. While that job — or the retry it queued, or
					// the retry after that — can still run, there is nothing to do. Once the whole
					// chain has finished, the slot should no longer be due: a run that worked, and
					// a chain the retry policy gave up on, both rolled `nextRunAt` forward. If it
					// IS still due, the queue gave up on a job before the handler's own failure
					// path could run — a worker that kept dying mid-run, a lease that lapsed during
					// a long outage, a cancel from /settings/jobs — and nothing will ever move the
					// schedule. Skip the slot the way an exhausted retry chain does; otherwise the
					// automation stays due, every tick finds the same dead chain, and a handful of
					// wedged rows fill the 25-row page above and starve every other automation.
					const chain = await followRetryChain(job)
					if (!chain.active && (await skipScheduledSlot(automation, now))) {
						const which = chain.last.id === job.id ? 'slot job' : 'retry job'
						enqueued.push({
							automationId: automation.id,
							jobId: chain.last.id,
							created,
							skipped: `${which} ${chain.last.status}`,
						})
						continue
					}
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

/** More hops than any real chain has (one job per attempt), so a malformed result cannot loop. */
const MAX_RETRY_CHAIN_HOPS = 10

/**
 * Where a slot's run has got to. A failed attempt does not fail its job: the handler records
 * the failure, queues the next attempt as a job of its own, and returns `{ retrying: true,
 * retryJobId }`, so the slot's job ends `completed` either way. Follow those links to the
 * newest job. The chain is `active` while that job may still run; otherwise it has finished,
 * and `last` is how it ended.
 */
async function followRetryChain(slotJob: JobRow): Promise<{ active: boolean; last: JobRow }> {
	const { ACTIVE_JOB_STATUSES, getJobById } = await import('$lib/jobs/jobs.server')
	const isActive = (job: JobRow) => (ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status)
	let job = slotJob
	for (let hop = 0; hop < MAX_RETRY_CHAIN_HOPS; hop += 1) {
		if (isActive(job)) return { active: true, last: job }
		const retryJobId = job.status === 'completed' && job.result?.retrying === true ? job.result.retryJobId : null
		if (typeof retryJobId !== 'string') break
		const next = await getJobById(retryJobId)
		if (!next) break
		job = next
	}
	return { active: isActive(job), last: job }
}

/**
 * Roll `nextRunAt` past a slot that will never run. `lastRunAt` is untouched — nothing ran.
 *
 * Only if the automation is still on that slot: the handler moves `nextRunAt` before the
 * worker marks its job completed, so a tick that read the row just before a successful run
 * finished sees a finished chain for a slot that has already moved on. Returns whether the
 * slot was skipped.
 */
async function skipScheduledSlot(automation: typeof automations.$inferSelect, now: Date): Promise<boolean> {
	const slot = automation.nextRunAt
	if (!slot) return false
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
		return false
	}
	const moved = await db
		.update(automations)
		.set({ nextRunAt, updatedAt: now })
		.where(
			and(
				eq(automations.id, automation.id),
				// Compared to the millisecond: that is all a JS Date carries of the stored value.
				sql`date_trunc('milliseconds', ${automations.nextRunAt}) = ${slot.toISOString()}::timestamptz`,
			),
		)
		.returning({ id: automations.id })
	if (moved.length === 0) return false
	logger.warn('[automations] skipped a slot whose job chain ended without moving the schedule', {
		automationId: automation.id,
		slot: slot.toISOString(),
		nextRunAt: nextRunAt.toISOString(),
	})
	return true
}
