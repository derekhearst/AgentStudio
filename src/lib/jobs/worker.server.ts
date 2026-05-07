import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
	beginJob,
	cancelJob as _cancel,
	claimNextJob,
	completeJob,
	failJob,
	heartbeatJob,
	type ClaimJobOptions,
} from './jobs.server'
import type { JobRow } from './jobs.schema'
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
 *   - Calls `ctx.checkCancellation()` at safe boundaries to honor cancellation
 *
 * The worker is opt-in: callers wire `startJobWorker()` once on boot behind an env flag so
 * test environments don't spin up a polling loop.
 */

export type JobHandlerContext = {
	job: JobRow
	workerId: string
	/** Throws when the job has been canceled — handlers should call at safe boundaries. */
	checkCancellation: () => Promise<void>
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
	/** Filter by job type. Default: all registered types. */
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
	stop: () => Promise<void>
	/** Process exactly one available job (returns false when queue is empty). For tests + Phase 1 manual ticks. */
	tickOnce: () => Promise<boolean>
}

/**
 * Start the worker loop. Returns a Worker handle that can be stopped on shutdown. Most
 * callers will use a single instance per process; a future Phase 6 split runs N instances
 * across a worker pool.
 *
 * NOTE: this is opt-in — the SvelteKit server doesn't auto-start a worker. The intended
 * trigger is a boot-time check (`if (env.JOBS_WORKER_ENABLED) startJobWorker()`) or an
 * external worker process that imports this module.
 */
export function startJobWorker(opts: WorkerOptions = {}): Worker {
	const workerId = opts.workerId ?? `${hostname()}:${randomUUID().slice(0, 8)}`
	const leaseTtlMs = opts.leaseTtlMs ?? 60_000
	const pollIntervalMs = opts.pollIntervalMs ?? 1_000
	let stopped = false

	async function processOne(): Promise<boolean> {
		if (stopped) return false
		if (handlers.size === 0) return false
		const claimOpts: ClaimJobOptions = {
			workerId,
			leaseTtlMs,
			queues: opts.queues,
			types: opts.types ?? [...handlers.keys()],
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
					if (!fresh) throw new Error(`Job ${job.id} canceled or removed`)
				},
			})
			await completeJob(job.id, normalizeResult(result))
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
		// Defer the first poll briefly so module-level awaits in db.server.ts (the `db` export
		// resolves AFTER `await databaseReadyPromise`) have a chance to settle. Otherwise the
		// first claim runs against an undefined db proxy.
		await delay(2_000)
		while (!stopped) {
			try {
				const processed = await processOne()
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
		stop: async () => {
			stopped = true
		},
		tickOnce: () => processOne(),
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
