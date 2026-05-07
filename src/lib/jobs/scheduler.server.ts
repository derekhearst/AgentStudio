import { enqueueJob, type EnqueueJobInput } from './jobs.server'
import { logger } from '$lib/observability/logger'

/**
 * Wave 4 #17 phase 4 — lightweight in-process job scheduler.
 *
 * Recurring schedules are registered at boot (e.g. workspace_gc daily, stale-run cleanup
 * hourly). The scheduler keeps an in-memory map of `{name → {intervalMs, enqueueFn}}` and
 * fires a `setInterval` per registered schedule that calls `enqueueJob` on tick.
 *
 * Idempotency comes from `dedupeKey` on the enqueue: if the previous tick's job is still
 * pending (worker hasn't claimed it yet), the next tick's enqueue collides on the
 * `(type, dedupe_key)` unique index and returns the existing row instead of stacking up
 * duplicate work.
 *
 * V1 scope: simple intervalMs (not full cron). Full cron parsing can land later when a real
 * use case needs hour-of-day specificity. Workspace GC + memory mining backfills are fine
 * with "every 24h" semantics.
 *
 * Lifecycle:
 *   - registerScheduledJob({name, intervalMs, enqueue}) called at boot, BEFORE startJobWorker
 *   - startScheduler() kicks off the timers; opt-out via JOBS_SCHEDULER_ENABLED=0
 *   - stopScheduler() (returned by startScheduler) clears all timers for shutdown / tests
 */

export type ScheduledJob = {
	/** Human-readable name for logging. Also used as the dedupeKey suffix. */
	name: string
	/** Interval between enqueues, in milliseconds. */
	intervalMs: number
	/**
	 * Optional initial delay before the first enqueue. Defaults to a small jitter (5-30s)
	 * so multiple schedules don't all fire at boot+0.
	 */
	initialDelayMs?: number
	/**
	 * Build the enqueue input on each tick. Lets the scheduler defer payload construction
	 * (e.g. compute scheduledAt = now()) until the moment the job goes onto the queue.
	 */
	enqueue: () => EnqueueJobInput
}

const registry = new Map<string, ScheduledJob>()

export function registerScheduledJob(spec: ScheduledJob): void {
	if (spec.intervalMs < 1_000) {
		throw new Error(`scheduled job "${spec.name}" intervalMs must be >= 1s (got ${spec.intervalMs})`)
	}
	registry.set(spec.name, spec)
}

export function listScheduledJobs(): ScheduledJob[] {
	return [...registry.values()]
}

export function _resetScheduler(): void {
	registry.clear()
}

export type Scheduler = {
	stop: () => void
	/** Manually fire all registered schedules once (for tests). */
	tickAll: () => Promise<void>
}

export function startScheduler(): Scheduler {
	const timers: ReturnType<typeof setInterval>[] = []

	for (const job of registry.values()) {
		const initialDelay = job.initialDelayMs ?? Math.floor(5_000 + Math.random() * 25_000)
		// First enqueue after initialDelay, then every intervalMs.
		const firstFire = setTimeout(() => {
			void enqueueOnce(job)
			const tick = setInterval(() => void enqueueOnce(job), job.intervalMs)
			timers.push(tick)
		}, initialDelay)
		timers.push(firstFire as unknown as ReturnType<typeof setInterval>)
	}

	return {
		stop: () => {
			for (const t of timers) clearInterval(t)
			timers.length = 0
		},
		tickAll: async () => {
			for (const job of registry.values()) {
				await enqueueOnce(job)
			}
		},
	}
}

async function enqueueOnce(job: ScheduledJob): Promise<void> {
	try {
		const input = job.enqueue()
		await enqueueJob(input)
	} catch (err) {
		logger.warn('[jobs/scheduler] enqueue failed', {
			name: job.name,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
