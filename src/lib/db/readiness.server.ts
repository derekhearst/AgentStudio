/**
 * Boot-time database readiness: wait out a Postgres that is still starting, and remember
 * a failed bootstrap so it is reported rather than swallowed.
 *
 * Before this, `bootstrapDatabase` caught every error and only logged it, and
 * `ensureDatabaseReady()` resolved anyway. A host reboot that brought the app up a few
 * seconds before Postgres left the process serving pages with no job handlers, no worker,
 * no scheduler and no log sink — and `/api/health` said ok, because by the time anyone
 * looked the database was reachable. Nothing ever retried.
 *
 * Now:
 *   - bootstrap retries connection-class failures with backoff (`retryOnTransientConnectionError`);
 *   - a bootstrap that still fails makes every `ensureDatabaseReady()` reject, so requests
 *     fail loudly instead of running against a half-initialised database;
 *   - after a cooldown the next caller starts a fresh attempt (`createBootstrapGate`),
 *     which is how the app recovers from an outage that outlasted the retries.
 *
 * No `$lib` imports and no database access, so the whole module is unit-testable.
 */

/**
 * Error codes meaning "the database is not reachable yet" rather than "something is wrong
 * with it". Socket errors come from Node/Bun, the upper-case words from postgres.js, and
 * the SQLSTATEs from a server that is up but not accepting work.
 */
export const TRANSIENT_CONNECTION_ERROR_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'ETIMEDOUT',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EAI_AGAIN',
	'ENOTFOUND',
	'EPIPE',
	'CONNECT_TIMEOUT',
	'CONNECTION_CLOSED',
	'57P01', // admin_shutdown
	'57P02', // crash_shutdown
	'57P03', // cannot_connect_now — the server is starting up
	'53300', // too_many_connections
	'08000', // connection_exception
	'08001', // sqlclient_unable_to_establish_sqlconnection
	'08003', // connection_does_not_exist
	'08004', // sqlserver_rejected_establishment_of_sqlconnection
	'08006', // connection_failure
])

/** Every error code on an error, its `cause` chain and any `AggregateError` members. */
function collectErrorCodes(error: unknown, into: Set<string> = new Set(), depth = 0): Set<string> {
	if (!error || typeof error !== 'object' || depth > 8) return into
	const record = error as Record<string, unknown>
	if (typeof record.code === 'string') into.add(record.code)
	collectErrorCodes(record.cause, into, depth + 1)
	if (Array.isArray(record.errors)) {
		for (const member of record.errors) collectErrorCodes(member, into, depth + 1)
	}
	return into
}

export function isTransientConnectionError(error: unknown): boolean {
	for (const code of collectErrorCodes(error)) {
		if (TRANSIENT_CONNECTION_ERROR_CODES.has(code)) return true
	}
	return false
}

/**
 * Backoff for the first bootstrap: about two and a half minutes in total, which covers a
 * Postgres container that is still replaying WAL after a host reboot.
 */
export const BOOTSTRAP_RETRY_DELAYS_MS: readonly number[] = [
	1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000, 30_000,
]

export type RetryOptions = {
	/** One entry per retry; an empty list means a single attempt. */
	delaysMs?: readonly number[]
	sleep?: (ms: number) => Promise<void>
	onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

/** Run `fn`, retrying only while it fails for connection-class reasons. */
export async function retryOnTransientConnectionError<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const delays = options.delaysMs ?? BOOTSTRAP_RETRY_DELAYS_MS
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

	for (let attempt = 0; ; attempt++) {
		try {
			return await fn()
		} catch (error) {
			const delayMs = delays[attempt]
			if (delayMs === undefined || !isTransientConnectionError(error)) throw error
			options.onRetry?.(error, attempt + 1, delayMs)
			await sleep(delayMs)
		}
	}
}

/** How long a failed bootstrap is reported before the next caller may try again. */
export const BOOTSTRAP_REATTEMPT_AFTER_MS = 30_000

export type BootstrapState = 'pending' | 'ready' | 'failed'

export type BootstrapGate = {
	/** Resolves once bootstrap has succeeded; rejects while it is failed. */
	ensureReady(): Promise<void>
	readonly state: BootstrapState
}

export type BootstrapGateOptions = {
	reattemptAfterMs?: number
	now?: () => number
}

/** What `ensureDatabaseReady()` throws while bootstrap is failed. */
export class DatabaseUnavailableError extends Error {
	constructor(cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause)
		super(`Database bootstrap failed, so the app cannot serve requests: ${detail}`, { cause })
		this.name = 'DatabaseUnavailableError'
	}
}

/**
 * Start `run` now and gate callers on its outcome. `run` receives the attempt number
 * (0 for the boot attempt) so later attempts can skip the long backoff — a request is
 * waiting on them. Success is final: `run` is never called again after it resolves.
 */
export function createBootstrapGate(
	run: (attempt: number) => Promise<void>,
	options: BootstrapGateOptions = {},
): BootstrapGate {
	const reattemptAfterMs = options.reattemptAfterMs ?? BOOTSTRAP_REATTEMPT_AFTER_MS
	const now = options.now ?? Date.now

	let state: BootstrapState = 'pending'
	let attempt = 0
	let failedAt = 0
	let current: Promise<void>

	const start = () => {
		state = 'pending'
		current = run(attempt++).then(
			() => {
				state = 'ready'
			},
			(error: unknown) => {
				state = 'failed'
				failedAt = now()
				throw error
			},
		)
		// Mark the rejection handled. A failed bootstrap must be reported to callers, not
		// crash the process as an unhandled rejection before anyone has asked.
		current.catch(() => {})
	}

	start()

	return {
		async ensureReady() {
			if (state === 'failed' && now() - failedAt >= reattemptAfterMs) start()
			try {
				await current
			} catch (error) {
				throw new DatabaseUnavailableError(error)
			}
		},
		get state() {
			return state
		},
	}
}
