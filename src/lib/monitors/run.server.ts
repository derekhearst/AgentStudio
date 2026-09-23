import { and, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { logger } from '$lib/observability/logger'
import { monitors, type MonitorRow, type MonitorStatus } from './monitors.schema'
import { getMonitorById } from './monitors.server'
import { evaluateMonitorCondition } from './evaluate.server'
import { dispatchMonitorAction } from './actions.server'
import {
	computeNextCheckAt,
	describeCondition,
	monitorConditionSchema,
	shouldFire,
	MONITOR_MAX_CONSECUTIVE_ERRORS,
} from './condition'

/**
 * #33 — one check of one monitor. This is the only place monitor state changes as a result
 * of observing the world, so the three failure modes are all visible side by side:
 *
 *   the condition is FALSE    → record the observation, clear the latch, reschedule. Routine.
 *   the check ERRORED         → record the error, back off geometrically, and deliberately do
 *                               NOT touch `lastObservation`. Treating a failed fetch as "the
 *                               value is now empty" would read as a change and fire the action
 *                               on an outage. After `MONITOR_MAX_CONSECUTIVE_ERRORS` in a row
 *                               the monitor retires as `failed` and opens a review item.
 *   the check was BLOCKED     → a budget cap would have been crossed. Nothing was spent and
 *                               no check is counted; the monitor reschedules and opens a
 *                               `policy_override_request` so an operator can lift the cap.
 *
 * What stops a monitor firing forever, in order of which bites first:
 *   1. the debounce latch — one action per false→true edge, not one per check
 *   2. `oneShot` — the default; the monitor retires the moment it fires
 *   3. `maxChecks` — the spend cap, counted in checks actually performed
 *   4. `deadlineAt` — the wall-clock cap, at most 30 days, extended only on request
 *   5. the error budget — five consecutive failures and it stops asking
 *
 * A check can take seconds (a fetch, maybe a model call), and the monitor is not locked while
 * it runs. So every write of a check's outcome is conditional on nothing having moved the
 * monitor in the meantime — see `commitIfUnchanged`. A cancel or pause that lands mid-check
 * wins: the check's result is discarded and its action never runs.
 */

export type MonitorCheckResult = {
	monitorId: string
	status: MonitorStatus
	/** 'skipped' when the monitor was not eligible; otherwise what the check concluded. */
	outcome: 'skipped' | 'observed' | 'fired' | 'error' | 'blocked' | 'expired' | 'exhausted'
	met?: boolean
	checkCount?: number
	nextCheckAt?: string | null
	detail?: Record<string, unknown>
}

/** Seams for specs. Production passes nothing and gets the real evaluator and actions. */
export type MonitorCheckDeps = {
	evaluate?: typeof evaluateMonitorCondition
	dispatch?: typeof dispatchMonitorAction
}

export async function runMonitorCheck(
	monitorId: string,
	now = new Date(),
	deps: MonitorCheckDeps = {},
): Promise<MonitorCheckResult> {
	const evaluate = deps.evaluate ?? evaluateMonitorCondition
	const dispatch = deps.dispatch ?? dispatchMonitorAction
	const monitor = await getMonitorById(monitorId)
	if (!monitor) throw new Error(`Monitor ${monitorId} not found`)

	if (monitor.status !== 'active') {
		return { monitorId, status: monitor.status, outcome: 'skipped', detail: { reason: `status=${monitor.status}` } }
	}

	// Deadline wins over everything, including a condition that is true right now. A monitor
	// past its deadline is not a monitor.
	if (new Date(monitor.deadlineAt).getTime() <= now.getTime()) {
		if (!(await commitIfUnchanged(monitor, { status: 'expired', updatedAt: now }))) return superseded(monitorId)
		return { monitorId, status: 'expired', outcome: 'expired' }
	}

	if (monitor.checkCount >= monitor.maxChecks) {
		if (!(await commitIfUnchanged(monitor, { status: 'exhausted', updatedAt: now }))) return superseded(monitorId)
		await openLifecycleReviewItem(monitor, 'exhausted', `used its ${monitor.maxChecks}-check budget without firing`)
		return { monitorId, status: 'exhausted', outcome: 'exhausted', checkCount: monitor.checkCount }
	}

	const evaluation = await evaluate(monitor, now)

	// ── blocked by a budget cap ──
	if (evaluation.outcome === 'blocked') {
		const nextCheckAt = computeNextCheckAt(now, monitor.intervalSeconds, 0)
		const committed = await commitIfUnchanged(monitor, {
			lastCheckedAt: now,
			nextCheckAt,
			lastError: evaluation.message,
			updatedAt: now,
		})
		if (!committed) return superseded(monitorId)
		void openBudgetReviewItem(monitor, evaluation.blockedBy, evaluation.message)
		void recordMonitorMetric('monitors.check.blocked', monitor)
		return {
			monitorId,
			status: 'active',
			outcome: 'blocked',
			nextCheckAt: nextCheckAt.toISOString(),
			detail: { limitId: evaluation.blockedBy.id, message: evaluation.message },
		}
	}

	// ── the check could not be completed ──
	if (evaluation.outcome === 'error') {
		const consecutiveErrors = monitor.consecutiveErrors + 1
		const checkCount = monitor.checkCount + 1
		const giveUp = consecutiveErrors >= MONITOR_MAX_CONSECUTIVE_ERRORS
		const budgetSpent = checkCount >= monitor.maxChecks
		const status: MonitorStatus = giveUp ? 'failed' : budgetSpent ? 'exhausted' : 'active'
		const nextCheckAt = computeNextCheckAt(now, monitor.intervalSeconds, consecutiveErrors)
		const committed = await commitIfUnchanged(monitor, {
			status,
			checkCount,
			consecutiveErrors,
			lastError: evaluation.message.slice(0, 2_000),
			lastCheckedAt: now,
			// Left in place even on a terminal status so the UI can show when it would have run.
			nextCheckAt,
			updatedAt: now,
		})
		// Canceled or paused while the check ran: a failure must not overwrite that with
		// `failed` or `exhausted`, nor open a review item about a monitor the user stopped.
		if (!committed) return superseded(monitorId)
		if (status !== 'active') {
			await openLifecycleReviewItem(
				monitor,
				status,
				giveUp
					? `failed ${consecutiveErrors} checks in a row — last error: ${evaluation.message.slice(0, 200)}`
					: `spent its check budget while erroring — last error: ${evaluation.message.slice(0, 200)}`,
			)
		}
		void recordMonitorMetric('monitors.check.error', monitor)
		logger.warn('[monitors] check failed', { monitorId, consecutiveErrors, error: evaluation.message })
		return {
			monitorId,
			status,
			outcome: 'error',
			checkCount,
			nextCheckAt: nextCheckAt.toISOString(),
			detail: { consecutiveErrors, message: evaluation.message },
		}
	}

	// ── a clean observation ──
	const { observation, met } = evaluation
	const fire = shouldFire(met, monitor.conditionMet)
	const checkCount = monitor.checkCount + 1
	const fireCount = fire ? monitor.fireCount + 1 : monitor.fireCount
	const budgetSpent = checkCount >= monitor.maxChecks
	const status: MonitorStatus = fire && monitor.oneShot ? 'fired' : budgetSpent ? 'exhausted' : 'active'
	const nextCheckAt = computeNextCheckAt(now, monitor.intervalSeconds, 0)

	// State is persisted BEFORE the action runs, so a crash mid-dispatch can lose the action
	// but can never double-fire: the latch and the fire counter are already committed, and a
	// retried job sees an edge that has already been consumed. The write is also the gate for
	// the action: if the user canceled or paused the monitor while this check ran, or another
	// check got here first, nothing is recorded and nothing fires.
	const committed = await commitIfUnchanged(monitor, {
		status,
		checkCount,
		fireCount,
		conditionMet: met,
		lastObservation: observation,
		lastCheckedAt: now,
		nextCheckAt,
		consecutiveErrors: 0,
		lastError: null,
		...(fire ? { lastFiredAt: now } : {}),
		updatedAt: now,
	})
	if (!committed) return superseded(monitorId)
	void recordMonitorMetric(fire ? 'monitors.fired' : 'monitors.check.observed', monitor)

	if (!fire) {
		return {
			monitorId,
			status,
			outcome: budgetSpent ? 'exhausted' : 'observed',
			met,
			checkCount,
			nextCheckAt: nextCheckAt.toISOString(),
			detail: { note: observation.note },
		}
	}

	const fireResult = await dispatch({ ...monitor, fireCount, lastObservation: observation }, observation, now)
	await patchMonitor(monitorId, { lastFireResult: { ...fireResult.detail, kind: fireResult.kind, ok: fireResult.ok }, updatedAt: new Date() })

	return {
		monitorId,
		status,
		outcome: 'fired',
		met,
		checkCount,
		nextCheckAt: status === 'active' ? nextCheckAt.toISOString() : null,
		detail: { action: fireResult.kind, ok: fireResult.ok, ...fireResult.detail },
	}
}

async function patchMonitor(monitorId: string, patch: Partial<typeof monitors.$inferInsert>): Promise<void> {
	await db.update(monitors).set(patch).where(eq(monitors.id, monitorId))
}

/**
 * Write a check's outcome only if the monitor is exactly as this check found it: still
 * `active`, and with the same `checkCount`. Returns false when anything moved it in between.
 *
 * The status half is what lets a cancel or pause win. The read happens before the check and
 * the write after it, so an unconditional write would put a canceled monitor back to
 * `active` (or `fired`) and still run its action. The `checkCount` half is optimistic
 * concurrency: "Check now" does not go through the dispatcher's claim, so it can overlap a
 * scheduled check, and without it both would commit and both could fire.
 */
async function commitIfUnchanged(monitor: MonitorRow, patch: Partial<typeof monitors.$inferInsert>): Promise<boolean> {
	const [row] = await db
		.update(monitors)
		.set(patch)
		.where(and(eq(monitors.id, monitor.id), eq(monitors.status, 'active'), eq(monitors.checkCount, monitor.checkCount)))
		.returning({ id: monitors.id })
	return row !== undefined
}

/** The result of a check whose outcome was discarded because the monitor changed under it. */
async function superseded(monitorId: string): Promise<MonitorCheckResult> {
	const current = await getMonitorById(monitorId)
	return {
		monitorId,
		status: current?.status ?? 'canceled',
		outcome: 'skipped',
		detail: { reason: 'the monitor changed while it was being checked; this result was discarded' },
	}
}

/** Best-effort metric. Never blocks or fails a check. */
async function recordMonitorMetric(metric: string, monitor: MonitorRow): Promise<void> {
	try {
		const { recordMetric } = await import('$lib/observability/metrics.server')
		await recordMetric({
			metric,
			dimension: { conditionKind: monitor.conditionKind, action: monitor.action },
			value: 1,
		})
	} catch (err) {
		logger.warn('[monitors] metric failed (non-fatal)', { err })
	}
}

/**
 * A monitor that retires without firing is still news — the operator asked for something to
 * be watched and it stopped being watched. Deduped on `(monitor, status)` so a retried job
 * cannot open the row twice.
 */
async function openLifecycleReviewItem(monitor: MonitorRow, status: MonitorStatus, why: string): Promise<void> {
	try {
		let watching = 'its condition'
		try {
			watching = describeCondition(monitorConditionSchema.parse(monitor.condition))
		} catch {
			// Unparseable stored condition — the summary is still worth opening.
		}
		const { openReviewItem } = await import('$lib/observability/review.server')
		await openReviewItem({
			type: 'monitor_fired',
			severity: status === 'failed' ? 'critical' : 'warning',
			summary: `Monitor "${monitor.name}" stopped (${status}) — it ${why}`.slice(0, 500),
			payload: {
				monitorId: monitor.id,
				monitorName: monitor.name,
				terminalStatus: status,
				watching,
				lastObservation: monitor.lastObservation,
			},
			dedupeKey: `monitor_lifecycle:${monitor.id}:${status}`,
		})
	} catch (err) {
		logger.warn('[monitors] lifecycle review item failed (non-fatal)', { err })
	}
}

/**
 * Mirrors the automation engine's budget-block side channel: the operator sees the same
 * `policy_override_request` shape in /review whether an automation or a monitor hit the cap.
 * Deduped per (limit, monitor) so a monitor checking every 15 minutes against a spent cap
 * opens one row, not ninety-six a day.
 */
async function openBudgetReviewItem(
	monitor: MonitorRow,
	blockedBy: { id: string; scope: string; scopeId: string | null; period: string; limitUsd: string },
	message: string,
): Promise<void> {
	try {
		const { openReviewItem } = await import('$lib/observability/review.server')
		await openReviewItem({
			type: 'policy_override_request',
			severity: 'warning',
			summary: `Monitor budget block: ${message} blocked "${monitor.name.slice(0, 80)}"`,
			payload: {
				kind: 'budget',
				source: 'monitor',
				limitId: blockedBy.id,
				scope: blockedBy.scope,
				scopeId: blockedBy.scopeId,
				period: blockedBy.period,
				limitUsd: blockedBy.limitUsd,
				userId: monitor.userId,
				monitorId: monitor.id,
				monitorName: monitor.name,
			},
			dedupeKey: `budget:${blockedBy.id}:${monitor.userId}:monitor:${monitor.id}`,
		})
	} catch (err) {
		logger.warn('[monitors] budget review item failed (non-fatal)', { err })
	}
}
