import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { registerJobHandler } from '$lib/jobs/worker.server'
import { registerScheduledJob } from '$lib/jobs/scheduler.server'
import { automations, type AutomationRunTrigger } from '$lib/automations/automation.schema'
import { logger } from '$lib/observability/logger'
import { AutomationUnavailableError, runAutomationById, checkAndRunAutomations } from './engine'
import { recordTerminalAutomationFailure } from './automation-failure.server'
import { pruneAutomationRuns, reapStalledAutomationRuns } from './automation-runs.server'
import {
	AUTOMATION_MAX_ATTEMPTS,
	AUTOMATION_RUN_RETENTION_DAYS,
	automationRetryDedupeKey,
	automationTriggerPolicy,
	computeRetryBackoffMs,
	describeRetryDecision,
	nextRetryAt,
	shouldRetryAutomation,
} from './failure-policy'

/**
 * Wave 4 #17 phase 5 finish — `automation_run` job handler + dispatch tick.
 *
 * Migrates automation execution from inline (cron route called runAutomation directly) to
 * the durable queue:
 *   - The dispatch tick (`automations:dispatch`) runs every minute via the in-process
 *     scheduler. It reuses `checkAndRunAutomations` which now ENQUEUES jobs for each due
 *     automation instead of running them inline.
 *   - The `automation_run` handler picks up the per-automation job and calls
 *     `runAutomationById` which delegates to the existing runAutomation pipeline + updates
 *     last_run_at / next_run_at on success.
 *
 * Benefits: ticks survive restart, per-automation dedupe via `automation:<id>:<slot>`
 * gives each scheduled slot exactly one job however many ticks see it due, failures show up
 * in `/settings/jobs` for forensics.
 *
 * The cron route (`/api/cron`) still works as an external trigger — it just calls the same
 * `checkAndRunAutomations` enqueue path. Useful for environments that prefer external cron
 * over the in-process scheduler: send `Authorization: Bearer $CRON_SECRET` (see
 * `cron-trigger.ts`; with no secret configured only a signed-in session can fire it).
 *
 * #31 — failure handling lives HERE rather than in the generic queue retry, and the handler
 * deliberately does not rethrow. Two reasons:
 *   - the queue's retry is a fixed per-type backoff; automations want an explicit
 *     escalating schedule (see failure-policy.ts) that is visible to the operator;
 *   - swallowing the throw keeps the generic `job_failure` review item from firing
 *     alongside the automation-specific one, so one broken automation produces one inbox
 *     row, not two.
 * The failed attempt is still recorded — in the `automation_runs` ledger, and in the job
 * result (`status: 'failed'`), so `/settings/jobs` forensics are unchanged.
 */

const AUTOMATION_RUN_PAYLOAD = z.object({
	automationId: z.string().uuid(),
	/** 1-based attempt within the current tick; retries carry attempt+1 forward. */
	attempt: z.number().int().min(1).max(10).optional(),
	trigger: z.enum(['schedule', 'manual', 'monitor']).optional(),
})

let registered = false

/**
 * The `automation_run` handler body, exported so specs can drive one job end to end without
 * a worker.
 *
 * An automation that is gone, or was switched off after this job was queued, is SKIPPED —
 * not failed. That case is typically a retry that was already waiting when the user
 * disabled the automation, or a monitor firing at one they turned off. Sending it through
 * the failure policy would queue yet more attempts, bump the failure streak and push an
 * "Automation run failed" notification about something the user deliberately stopped.
 */
export async function executeAutomationRunJob(job: { id: string; payload: unknown }): Promise<Record<string, unknown>> {
	const parsed = AUTOMATION_RUN_PAYLOAD.safeParse(job.payload)
	if (!parsed.success) {
		throw new Error(`automation_run payload missing/invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
	}
	const { automationId } = parsed.data
	const attempt = parsed.data.attempt ?? 1
	const trigger = parsed.data.trigger ?? 'schedule'

	try {
		const result = await runAutomationById(automationId, new Date(), {
			trigger,
			attempt,
			jobId: job.id,
		})
		return {
			automationId,
			attempt,
			trigger,
			status: 'completed',
			conversationId: result.conversationId,
			nextRunAt: result.nextRunAt,
		}
	} catch (error) {
		if (error instanceof AutomationUnavailableError) {
			logger.info('[automations] run skipped — automation is no longer runnable', {
				automationId,
				attempt,
				trigger,
				reason: error.reason,
			})
			return { automationId, attempt, trigger, status: 'skipped', reason: error.reason }
		}
		const outcome = await handleAutomationRunFailure({
			automationId,
			attempt,
			trigger,
			jobId: job.id,
			error,
		})
		return { automationId, attempt, trigger, status: 'failed', ...outcome }
	}
}

export function registerAutomationJobHandlers(): void {
	if (registered) return

	registerJobHandler('automation_run', ({ job }) => executeAutomationRunJob(job))

	// Dispatch tick — every 60s, look for due automations and enqueue per-automation jobs.
	// The fixed key only collapses a tick onto one that is still queued or running (dedupe
	// covers active jobs), so a backed-up worker never stacks ticks, and every tick after the
	// previous one finished gets a job of its own. Idempotency per automation lives on the
	// automation_run jobs the tick enqueues, not here.
	registerScheduledJob({
		name: 'automations.dispatch',
		intervalMs: 60_000,
		initialDelayMs: 15_000, // small jitter post-boot so it doesn't clash with workspace_gc
		enqueue: () => ({
			type: 'automations_dispatch',
			queue: 'maintenance',
			priority: 30, // above maintenance GC (10), below evaluation_run (75)
			dedupeKey: 'automations:dispatch',
			payload: {},
		}),
	})

	registerJobHandler('automations_dispatch', async () => {
		const result = await checkAndRunAutomations()

		// #31 — ledger housekeeping rides along with the tick that is already running every
		// minute. Both passes are cheap no-ops most of the time: the reaper touches only rows
		// stuck in `running`, and the prune runs on the hour.
		const now = new Date()
		const reaped = await reapStalledAutomationRuns(undefined, now)
		const pruned = now.getMinutes() === 0 ? await pruneAutomationRuns(AUTOMATION_RUN_RETENTION_DAYS, now) : 0

		return {
			evaluated: result.evaluated,
			enqueued: result.enqueued.filter((e) => e.created).length,
			errors: result.enqueued.filter((e) => !!e.error).length,
			reapedRuns: reaped,
			prunedRuns: pruned,
		}
	})

	registered = true
}

/**
 * #31 — retry with backoff, then give up loudly.
 *
 * Under the attempt cap we enqueue the next attempt as its own `automation_run` job,
 * scheduled into the future by the policy's backoff. At the cap we stop retrying and hand
 * off to `recordTerminalAutomationFailure`, which bumps the failure streak, may disable the
 * automation, and opens the review item + notification.
 *
 * Manual runs are never retried — a human is standing there and can press the button again;
 * silently queuing background retries behind a button press is surprising. A manual failure
 * also does not count toward the disable streak, because the streak is about the schedule.
 *
 * A monitor-fired run is escalated like a scheduled one: nobody is watching it either, and a
 * failure nobody hears about is the silence #31 set out to end. The retry carries the
 * trigger forward, and giving up leaves the schedule where it is — the schedule did not fail.
 */
async function handleAutomationRunFailure(args: {
	automationId: string
	attempt: number
	trigger: AutomationRunTrigger
	jobId: string
	error: unknown
}): Promise<Record<string, unknown>> {
	const message = args.error instanceof Error ? args.error.message : String(args.error)
	const policy = automationTriggerPolicy(args.trigger)

	if (!policy.escalateFailures) {
		logger.warn('[automations] manual run failed', {
			automationId: args.automationId,
			error: message,
		})
		return { retrying: false, error: message, reason: 'manual runs are not retried' }
	}

	if (shouldRetryAutomation(args.attempt)) {
		const nextAttempt = args.attempt + 1
		const runAt = nextRetryAt(args.attempt, new Date())
		logger.warn(`[automations] ${describeRetryDecision(args.attempt)}`, {
			automationId: args.automationId,
			error: message,
		})
		try {
			const { enqueueJob } = await import('$lib/jobs/jobs.server')
			const [automation] = await db
				.select({ userId: automations.userId })
				.from(automations)
				.where(eq(automations.id, args.automationId))
				.limit(1)
			const retryJob = await enqueueJob({
				type: 'automation_run',
				queue: 'default',
				priority: 50,
				scheduledAt: runAt,
				// Keyed on the job that failed, and `forever`, so re-delivery of the same
				// failure can't fan out into a second retry chain even after the first retry
				// has already run.
				dedupeKey: automationRetryDedupeKey(args.jobId, args.automationId, nextAttempt),
				dedupeScope: 'forever',
				payload: { automationId: args.automationId, attempt: nextAttempt, trigger: args.trigger },
				userId: automation?.userId ?? null,
			})
			return {
				retrying: true,
				error: message,
				nextAttempt,
				retryJobId: retryJob.id,
				retryAt: runAt.toISOString(),
				backoffMs: computeRetryBackoffMs(args.attempt),
			}
		} catch (err) {
			logger.warn('[automations] retry enqueue failed — treating the tick as terminal', { err })
			// Fall through to the terminal path: a tick we cannot retry is a tick that failed.
		}
	}

	const [automation] = await db
		.select()
		.from(automations)
		.where(eq(automations.id, args.automationId))
		.limit(1)
	if (!automation) {
		return { retrying: false, error: message, reason: 'automation row disappeared mid-tick' }
	}

	const outcome = await recordTerminalAutomationFailure({
		automation,
		error: args.error,
		attempts: args.attempt,
		jobId: args.jobId,
		advanceSchedule: !policy.preserveSchedule,
	})

	return {
		retrying: false,
		error: message,
		attempts: args.attempt,
		maxAttempts: AUTOMATION_MAX_ATTEMPTS,
		consecutiveFailures: outcome.consecutiveFailures,
		disabled: outcome.disabled,
		reviewItemId: outcome.reviewItemId,
	}
}
