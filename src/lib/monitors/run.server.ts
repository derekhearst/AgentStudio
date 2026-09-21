import { eq } from 'drizzle-orm'
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

export async function runMonitorCheck(monitorId: string, now = new Date()): Promise<MonitorCheckResult> {
	const monitor = await getMonitorById(monitorId)
	if (!monitor) throw new Error(`Monitor ${monitorId} not found`)

	if (monitor.status !== 'active') {
		return { monitorId, status: monitor.status, outcome: 'skipped', detail: { reason: `status=${monitor.status}` } }
	}

	// Deadline wins over everything, including a condition that is true right now. A monitor
	// past its deadline is not a monitor.
	if (new Date(monitor.deadlineAt).getTime() <= now.getTime()) {
		await patchMonitor(monitorId, { status: 'expired', updatedAt: now })
		return { monitorId, status: 'expired', outcome: 'expired' }
	}

	if (monitor.checkCount >= monitor.maxChecks) {
		await patchMonitor(monitorId, { status: 'exhausted', updatedAt: now })
		await openLifecycleReviewItem(monitor, 'exhausted', `used its ${monitor.maxChecks}-check budget without firing`)
		return { monitorId, status: 'exhausted', outcome: 'exhausted', checkCount: monitor.checkCount }
	}

	const evaluation = await evaluateMonitorCondition(monitor, now)

	// ── blocked by a budget cap ──
	if (evaluation.outcome === 'blocked') {
		const nextCheckAt = computeNextCheckAt(now, monitor.intervalSeconds, 0)
		await patchMonitor(monitorId, {
			lastCheckedAt: now,
			nextCheckAt,
			lastError: evaluation.message,
			updatedAt: now,
		})
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
		await patchMonitor(monitorId, {
			status,
			checkCount,
			consecutiveErrors,
			lastError: evaluation.message.slice(0, 2_000),
			lastCheckedAt: now,
			// Left in place even on a terminal status so the UI can show when it would have run.
			nextCheckAt,
			updatedAt: now,
		})
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
	// retried job sees an edge that has already been consumed.
	await patchMonitor(monitorId, {
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

	const fireResult = await dispatchMonitorAction({ ...monitor, fireCount, lastObservation: observation }, observation, now)
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
