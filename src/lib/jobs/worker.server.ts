import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
	beginJob,
	cancelJob as _cancel,
	claimNextJob,
	completeJob,
	failJob,
	getJobById,
	heartbeatJob,
	type ClaimJobOptions,
} from './jobs.server'
import type { JobRow } from './jobs.schema'
import { createInFlightTracker } from './in-flight'
import { logger } from '$lib/observability/logger'

/**
 * Wave 4 #17 phase 1 — minimal in-process worker loop.
 *
 * Polls the queue for the next eligible job, dispatches to the registered handler for the
 * job's `type`, and reports completion / failure. Heartbeats every (leaseTtlMs / 3) so the
 * lease never expires mid-work. Designed to run inside the SvelteKit server (Phase 1) — the
 * Phase 6 split into a dedicated worker process plugs into the same primitives.
 *
 * Handler contract:
 *   - Async function `(job: JobRow, ctx: HandlerContext) => Promise<JobResult>`
 *   - Throws → failJob (which retries up to maxAttempts then transitions to failed)
 *   - Returns a result → completeJob with the result as metadata
 *   - Either way, a job that was canceled while it ran stays canceled (see jobs.server)
 *   - Calls `ctx.checkCancellation()` at safe boundaries to honor cancellation
 *
 * The worker is opt-in: callers wire `startJobWorker()` once on boot behind an env flag so
 * test environments don't spin up a polling loop. The boot path reads its options from the
 * environment (worker-config.ts) and keeps the handle (db/process-state.server.ts), so a
 * standalone worker can drain on shutdown and a re-evaluated dev module can stop the old
 * loop.
 */

export type JobHandlerContext = {
	job: JobRow
	workerId: string
	/**
	 * Throws `JobCanceledError` when the job has been canceled — handlers should call at safe
	 * boundaries. Any other error it throws is not a cancellation: a database hiccup, or the
	 * queue having taken the job back after this worker's lease lapsed (`errorForLostJob`).
	 */
	checkCancellation: () => Promise<void>
}

/**
 * What `checkCancellation` throws when the job was canceled or removed.
 *
 * Its own type so a handler can tell "stop, the user canceled" from "the heartbeat write
 * failed". The research runner used to see a plain Error here, record the run as failed
 * over the user's cancel, and hand the worker a failure to retry — so a canceled run came
 * back and finished.
 */
export class JobCanceledError extends Error {
	constructor(jobId: string) {
		super(`Job ${jobId} canceled or removed`)
		this.name = 'JobCanceledError'
	}
}

export function isJobCanceledError(err: unknown): err is JobCanceledError {
	return err instanceof JobCanceledError || (err instanceof Error && err.name === 'JobCanceledError')
}

/**
 * What `checkCancellation` throws once the heartbeat finds the job no longer in flight.
 *
 * `heartbeatJob` returns null for a job that was canceled, and also for one the claim path
 * retired as failed after this worker's lease lapsed — a database outage longer than the
 * lease. Only the first is a cancel. Reporting the second as one would record a research run
 * as canceled by a user who never pressed Cancel, so it gets a plain Error, which a handler
 * treats as the failure it is. A job that is gone counts as canceled, as it always has.
 */
export async function errorForLostJob(jobId: string): Promise<Error> {
	const current = await getJobById(jobId)
	if (!current || current.status === 'canceled') return new JobCanceledError(jobId)
	return new Error(`Job ${jobId} was taken back by the queue (now ${current.status}) after this worker's lease lapsed`)
}

export type JobResult = Record<string, unknown> | undefined | void

export type JobHandler = (ctx: JobHandlerContext) => Promise<JobResult>

const handlers = new Map<string, JobHandler>()

export function registerJobHandler(type: string, handler: JobHandler): void {
	handlers.set(type, handler)
}

export function getRegisteredHandlerTypes(): string[] {
	return [...handlers.keys()]
}

export function _resetJobHandlers(): void {
	handlers.clear()
}

export type WorkerOptions = {
	/** Filter by queue. Default: all queues. */
	queues?: string[]
	/**
	 * Filter by job type. Default: all registered types. Types without a registered handler
	 * are dropped from the filter — claiming one would only fail it for want of a handler.
	 */
	types?: string[]
	/** Lease TTL — default 60s. Heartbeats every (leaseTtlMs/3). */
	leaseTtlMs?: number
	/** Poll interval when the queue is empty. Default 1s. */
	pollIntervalMs?: number
	/** Worker identifier (logged into job_leases). Default: hostname + random suffix. */
	workerId?: string
}

export type Worker = {
	readonly workerId: string
	/**
	 * Stop claiming jobs. With `timeoutMs`, also wait up to that long for the job in flight to
	 * finish (heartbeats keep its lease alive meanwhile). Resolves true when nothing is left
	 * running; false when a job was still in flight at the deadline — it is abandoned
	 * mid-handler if the process then exits, and the next worker reclaims it once its lease
	 * lapses.
	 */
	stop: (opts?: { timeoutMs?: number }) => Promise<boolean>
	/** Process exactly one available job (returns false when queue is empty). For tests + Phase 1 manual ticks. */
	tickOnce: () => Promise<boolean>
}

/**
 * Start the worker loop. Returns a Worker handle that can be stopped on shutdown. Most
 * callers will use a single instance per process; a future Phase 6 split runs N instances
 * across a worker pool.
 *
 * The boot path (db/bootstrap.server.ts) starts one per process unless
 * `JOBS_WORKER_ENABLED=0`; `scripts/worker.ts` is that same boot path without the web tier.
 */
export function startJobWorker(opts: WorkerOptions = {}): Worker {
	const workerId = opts.workerId ?? `${hostname()}:${randomUUID().slice(0, 8)}`
	const leaseTtlMs = opts.leaseTtlMs ?? 60_000
	const pollIntervalMs = opts.pollIntervalMs ?? 1_000
	let stopped = false
	/** The `processOne` currently running, so `stop()` can wait for it. */
	const inFlight = createInFlightTracker()

	async function processOne(): Promise<boolean> {
		if (stopped) return false
		if (handlers.size === 0) return false
		const types = opts.types ? opts.types.filter((type) => handlers.has(type)) : [...handlers.keys()]
		// An empty list would build no type filter at all and claim EVERY type.
		if (types.length === 0) return false
		const claimOpts: ClaimJobOptions = {
			workerId,
			leaseTtlMs,
			queues: opts.queues,
			types,
		}
		const job = await claimNextJob(claimOpts).catch((err) => {
			logger.warn('[jobs/worker] claimNextJob failed', { err })
			return null
		})
		if (!job) return false

		const handler = handlers.get(job.type)
		if (!handler) {
			// No registered handler — release the lease and let another worker pick it up.
			await failJob(job.id, {
				error: { message: `no registered handler for job type "${job.type}"` },
			}).catch(() => undefined)
			return true
		}

		await beginJob(job.id).catch((err) => {
			logger.warn('[jobs/worker] beginJob failed — proceeding anyway', { err })
		})

		// Set up a heartbeat tick so the lease doesn't expire during long handlers.
		let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
			void heartbeatJob(job.id, leaseTtlMs).catch(() => undefined)
		}, Math.max(1_000, Math.floor(leaseTtlMs / 3)))

		try {
			const result = await handler({
				job,
				workerId,
				checkCancellation: async () => {
					const fresh = await heartbeatJob(job.id, leaseTtlMs)
					if (!fresh) throw await errorForLostJob(job.id)
				},
			})
			const finished = await completeJob(job.id, normalizeResult(result))
			if (!finished) {
				// Canceled, or retired by another worker after this one's lease lapsed: whatever
				// happened to the job meanwhile stands.
				logger.info('[jobs/worker] job was no longer in flight when its handler finished; result not recorded', {
					jobId: job.id,
					type: job.type,
				})
			}
		} catch (err) {
			await failJob(job.id, {
				error: { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
			}).catch(() => undefined)
		} finally {
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer)
				heartbeatTimer = null
			}
		}
		return true
	}

	async function loop() {
		// Defer the first poll briefly. Bootstrap only starts the worker once migrations have
		// run, so the database is ready; the delay lets the rest of startup (the scheduler,
		// background backfills) get going before the first claim.
		await delay(2_000)
		while (!stopped) {
			try {
				const processed = await inFlight.track(processOne())
				if (!processed) {
					await delay(pollIntervalMs)
				}
			} catch (err) {
				logger.warn('[jobs/worker] loop iteration crashed', { err })
				await delay(pollIntervalMs)
			}
		}
	}

	void loop()

	return {
		workerId,
		stop: async ({ timeoutMs = 0 } = {}) => {
			stopped = true
			return inFlight.drain(timeoutMs)
		},
		tickOnce: () => inFlight.track(processOne()),
	}
}

function normalizeResult(result: JobResult): Record<string, unknown> | undefined {
	if (result === null || result === undefined) return undefined
	if (typeof result === 'object') return result as Record<string, unknown>
	return undefined
}

function delay(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Re-export cancelJob so the worker module is the canonical surface for "the job lifecycle"
// even when callers don't import jobs.server directly.
export const cancelJob = _cancel
