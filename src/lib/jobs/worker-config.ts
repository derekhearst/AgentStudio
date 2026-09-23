/**
 * Job worker settings, read from the environment by the bootstrap that starts every worker —
 * the web tier's in-process one and `scripts/worker.ts` alike. Pure (no database, no
 * SvelteKit) so a spec can pin the parsing.
 *
 *   JOBS_WORKER_QUEUES    comma-separated queues to claim from. Unset or empty: every queue.
 *   JOBS_WORKER_TYPES     comma-separated job types to claim. Unset or empty: every type with a
 *                         registered handler. Listed types without a handler are ignored.
 *   JOBS_WORKER_POLL_MS   how long an idle worker waits between polls. Default 2000.
 *   JOBS_WORKER_LEASE_MS  lease TTL; the worker heartbeats every third of it, and a job whose
 *                         worker stops heartbeating is reclaimed once it lapses. Default 120000,
 *                         minimum 5000.
 *   JOBS_WORKER_ID        the id recorded in `job_leases`. Default `<hostname>:<random>`.
 *   JOBS_WORKER_DRAIN_MS  how long `scripts/worker.ts` waits, on SIGINT/SIGTERM, for the job in
 *                         flight to finish before exiting. Default 25000.
 *
 * A value that does not parse falls back to its default rather than failing the boot.
 */

export const DEFAULT_WORKER_POLL_MS = 2_000
export const DEFAULT_WORKER_LEASE_MS = 120_000
export const MIN_WORKER_LEASE_MS = 5_000
export const DEFAULT_WORKER_DRAIN_MS = 25_000

type Env = Record<string, string | undefined>

export type WorkerEnvOptions = {
	queues?: string[]
	types?: string[]
	pollIntervalMs: number
	leaseTtlMs: number
	workerId?: string
}

export function workerOptionsFromEnv(env: Env = process.env): WorkerEnvOptions {
	return {
		queues: parseList(env.JOBS_WORKER_QUEUES),
		types: parseList(env.JOBS_WORKER_TYPES),
		pollIntervalMs: parsePositiveInt(env.JOBS_WORKER_POLL_MS) ?? DEFAULT_WORKER_POLL_MS,
		leaseTtlMs: Math.max(MIN_WORKER_LEASE_MS, parsePositiveInt(env.JOBS_WORKER_LEASE_MS) ?? DEFAULT_WORKER_LEASE_MS),
		workerId: env.JOBS_WORKER_ID?.trim() || undefined,
	}
}

export function drainTimeoutFromEnv(env: Env = process.env): number {
	return parsePositiveInt(env.JOBS_WORKER_DRAIN_MS) ?? DEFAULT_WORKER_DRAIN_MS
}

/** Comma-separated list → trimmed, non-empty entries; undefined when nothing is left. */
function parseList(value: string | undefined): string[] | undefined {
	const items = (value ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)
	return items.length > 0 ? items : undefined
}

function parsePositiveInt(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === '') return undefined
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}
