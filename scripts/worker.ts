#!/usr/bin/env bun
/**
 * Wave 4 #17 phase 6 — standalone job worker process.
 *
 * Runs the in-process job worker WITHOUT booting the SvelteKit web tier. Use this for
 * production deployments that want to scale workers independently of the web tier (one
 * web container + N worker containers). Each worker process polls the same Postgres
 * `jobs` table; `FOR UPDATE SKIP LOCKED` ensures no two workers claim the same row.
 *
 * Usage:
 *   $ bun scripts/worker.ts
 *
 * Options (via env). The bootstrap reads the JOBS_WORKER_* settings for every process that
 * runs a worker, the web tier included — see src/lib/jobs/worker-config.ts:
 *   DATABASE_URL          — required, same Postgres URL as the web tier
 *   JOBS_WORKER_QUEUES    — comma-separated queue list (e.g. "default,maintenance"). Default: all queues.
 *   JOBS_WORKER_TYPES     — comma-separated job-type list. Default: all registered types; listed
 *                           types with no registered handler are ignored.
 *   JOBS_WORKER_POLL_MS   — poll interval when queue is empty. Default 2000.
 *   JOBS_WORKER_LEASE_MS  — lease TTL. Default 120000, minimum 5000.
 *   JOBS_WORKER_ID        — worker identifier (logged into job_leases). Default <hostname>:<random>.
 *   JOBS_WORKER_DRAIN_MS  — how long a shutdown waits for the job in flight. Default 25000.
 *   JOBS_SCHEDULER_ENABLED=0 — opt out of the in-process scheduler in this worker. Use when running
 *                              N worker processes — only ONE should run the scheduler to avoid
 *                              duplicate scheduled-job ticks.
 *
 * The worker stays alive until SIGINT or SIGTERM. On the first signal it stops the scheduler,
 * stops claiming new jobs, and waits up to JOBS_WORKER_DRAIN_MS for the job in flight to
 * finish (lease heartbeats keep firing during the drain). A job still running when the wait
 * runs out is abandoned mid-handler; its lease lapses and the next worker reclaims it. A
 * second signal exits immediately.
 */

// Importing db.server runs the bootstrap: migrate, seed, register every handler, start the
// worker and scheduler. This script's only job is to keep that process up and shut it down
// cleanly. (JOBS_WORKER_ENABLED=0 would leave it nothing to run, so it exits.)
import { ensureDatabaseReady } from '$lib/db.server'
import { backgroundJobs } from '$lib/db/process-state.server'
import { drainTimeoutFromEnv } from '$lib/jobs/worker-config'

await ensureDatabaseReady()

const { worker } = backgroundJobs()
if (!worker) {
	console.error('[worker] No job worker is running — the bootstrap failed or JOBS_WORKER_ENABLED=0. Exiting.')
	process.exit(1)
}

console.log(`[worker] standalone job worker process started (id=${worker.workerId})`)
console.log('[worker] Send SIGINT or SIGTERM to drain + exit.')

let shuttingDown = false
async function shutdown(reason: string) {
	if (shuttingDown) {
		console.log(`[worker] ${reason} received again — exiting without waiting.`)
		process.exit(1)
	}
	shuttingDown = true

	const drainMs = drainTimeoutFromEnv()
	console.log(`[worker] ${reason} received — no longer claiming; waiting up to ${drainMs}ms for the job in flight…`)
	const { worker: running, scheduler } = backgroundJobs()
	scheduler?.stop()
	const drained = running ? await running.stop({ timeoutMs: drainMs }) : true
	console.log(
		drained
			? '[worker] drain complete, exiting.'
			: '[worker] drain timed out — the job in flight will be reclaimed by the next worker once its lease lapses. Exiting.',
	)
	process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
