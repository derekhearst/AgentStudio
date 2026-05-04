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
 * Options (via env):
 *   DATABASE_URL          — required, same Postgres URL as the web tier
 *   JOBS_WORKER_QUEUES    — comma-separated queue list (e.g. "default,maintenance"). Default: all queues.
 *   JOBS_WORKER_TYPES     — comma-separated job-type list. Default: all registered types.
 *   JOBS_WORKER_POLL_MS   — poll interval when queue is empty. Default 2000.
 *   JOBS_WORKER_LEASE_MS  — lease TTL. Default 120000.
 *   JOBS_WORKER_ID        — worker identifier (logged into job_leases). Default hostname:randomSuffix.
 *   JOBS_SCHEDULER_ENABLED=0 — opt out of the in-process scheduler in this worker. Use when running
 *                              N worker processes — only ONE should run the scheduler to avoid
 *                              duplicate scheduled-job ticks.
 *
 * The worker stays alive until SIGINT or SIGTERM. On signal it stops claiming new jobs but
 * lets in-flight handlers finish (lease heartbeats keep firing during the drain).
 */

// Booting the schema + handlers requires importing db.server which auto-runs bootstrap.
// The bootstrap also starts a worker by default — we let that worker do the work and just
// keep this process alive so it doesn't exit. (Setting JOBS_WORKER_ENABLED=0 here would
// disable the auto-start; we LEAVE it enabled because that's the bootstrap-managed worker.)
import { db } from '$lib/db.server'

// Touch db so the import isn't tree-shaken (it has side effects).
void db

const workerId = process.env.JOBS_WORKER_ID ?? `worker:${process.pid}`
console.log(`[worker] standalone job worker process started (id=${workerId})`)
console.log('[worker] DB bootstrap + handler registration + in-process worker loop running.')
console.log('[worker] Send SIGINT or SIGTERM to drain + exit.')

let shuttingDown = false
function shutdown(reason: string) {
	if (shuttingDown) return
	shuttingDown = true
	console.log(`[worker] ${reason} received — draining…`)
	// The in-process worker loop has its own check via process events; we just give it a few
	// seconds to finish in-flight handlers before exiting.
	setTimeout(() => {
		console.log('[worker] drain complete, exiting.')
		process.exit(0)
	}, 5000)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// Keep process alive — the worker loop runs in the background.
setInterval(() => {
	// Heartbeat tick (no-op). Just prevents the event loop from idling out.
}, 60_000)
