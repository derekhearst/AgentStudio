import { z } from 'zod'
import { registerJobHandler } from '$lib/jobs/worker.server'
import { registerScheduledJob } from '$lib/jobs/scheduler.server'
import { logger } from '$lib/observability/logger'
import { claimMonitorForCheck, expireOverdueMonitors, listDueMonitors } from './monitors.server'
import { runMonitorCheck } from './run.server'

/**
 * #33 — how a monitor gets woken up.
 *
 * Two job types, mirroring the automations arrangement so there is one queue story in the
 * app rather than two:
 *
 *   monitors_dispatch — a 60-second scheduled tick. Retires anything past its deadline, then
 *                       enqueues a `monitor_check` for each monitor that is due. Cheap: one
 *                       indexed query, no per-monitor work.
 *   monitor_check     — the real work for one monitor. Runs on the durable queue, so it gets
 *                       leases, heartbeats and retries for free, and a failure is visible in
 *                       /settings/jobs afterwards.
 *
 * Why the deadline sweep lives on the tick rather than on the check: a monitor with a
 * 24-hour interval would otherwise sit "active" for up to a day past its deadline, because
 * nothing would look at it. The tick catches it within a minute.
 */

const MONITOR_CHECK_PAYLOAD = z.object({ monitorId: z.string().uuid() })

/** Per-tick fan-out ceiling. A backlog drains oldest-first over successive ticks. */
const MAX_DISPATCH_PER_TICK = 50

let registered = false

export function registerMonitorJobHandlers(): void {
	if (registered) return

	registerJobHandler('monitor_check', async ({ job }) => {
		const parsed = MONITOR_CHECK_PAYLOAD.safeParse(job.payload)
		if (!parsed.success) {
			throw new Error(`monitor_check payload missing/invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
		}
		const result = await runMonitorCheck(parsed.data.monitorId)
		return { ...result }
	})

	registerScheduledJob({
		name: 'monitors.dispatch',
		intervalMs: 60_000,
		// Offset from automations.dispatch (15s) and the GC schedules so the ticks don't all
		// land on the same second after a boot.
		initialDelayMs: 25_000,
		enqueue: () => ({
			type: 'monitors_dispatch',
			queue: 'maintenance',
			priority: 30,
			dedupeKey: 'monitors:dispatch',
			payload: {},
		}),
	})

	registerJobHandler('monitors_dispatch', async () => {
		const result = await dispatchDueMonitors()
		return { ...result }
	})

	registered = true
}

export type DispatchDueMonitorsResult = {
	runAt: string
	expired: number
	due: number
	enqueued: number
	skipped: number
	errors: number
}

export async function dispatchDueMonitors(now = new Date()): Promise<DispatchDueMonitorsResult> {
	const expired = await expireOverdueMonitors(now)
	const due = await listDueMonitors(now, MAX_DISPATCH_PER_TICK)

	let enqueued = 0
	let skipped = 0
	let errors = 0
	if (due.length > 0) {
		const { enqueueJob } = await import('$lib/jobs/jobs.server')
		for (const monitor of due) {
			try {
				// Claim first: the update pushes `nextCheckAt` one interval out and only
				// succeeds if the monitor is still due, so a check that outruns the tick
				// interval cannot be dispatched a second time while it is in flight.
				const claimed = await claimMonitorForCheck(monitor.id, now)
				if (!claimed) {
					skipped += 1
					continue
				}
				await enqueueJob({
					type: 'monitor_check',
					queue: 'default',
					// Above the maintenance tier, below interactive work — a monitor is
					// background, but a late check is a missed event.
					priority: 60,
					// Belt and braces on top of the claim: two dispatchers in the same tick
					// collapse onto one job row instead of two.
					dedupeKey: `monitor:${monitor.id}:${now.toISOString()}`,
					payload: { monitorId: monitor.id },
					userId: monitor.userId,
				})
				enqueued += 1
			} catch (err) {
				errors += 1
				logger.warn('[monitors] enqueue monitor_check failed', {
					monitorId: monitor.id,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}
	}

	return { runAt: now.toISOString(), expired, due: due.length, enqueued, skipped, errors }
}
