/**
 * Centralized logger for production code paths.
 *
 * Two sinks:
 *   - **Console** — always, in dev. In production only at `info` and above (configurable).
 *   - **Database** (`app_logs` table) — every entry, batched. Lets an operator browse
 *     warn/error events from the /observability/logs page (mobile-friendly), even with no
 *     terminal access.
 *
 * The DB sink is registered at server bootstrap via `registerDbSink()` (see
 * `logs-handler.server.ts`). This module has zero references — static or dynamic — to
 * `logs.server.ts`, so it stays browser-safe and the SvelteKit build guard is satisfied
 * when browser-bound modules import the logger.
 *
 * The DB sink is best-effort: writes are queued in memory and flushed on a timer. A failed
 * insert falls back to console, pauses the sink and retries later (see the retry policy
 * below), and never blocks the call site. Browser callers (the logger
 * is cross-environment-safe) skip the DB sink entirely — no sink is ever registered there.
 *
 * Verbosity is controlled by `LOG_LEVEL` (`debug`, `info`, `warn`, `error`); when unset it
 * defaults to `debug` in development and `info` in production.
 */

import type { LogLevel } from './observability.schema'

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
}

const isServer = typeof window === 'undefined'
const isDev =
	typeof process !== 'undefined' && process.env.NODE_ENV !== 'production'

function resolveActiveLevel(): LogLevel {
	const fromEnv = (typeof process !== 'undefined' ? process.env.LOG_LEVEL : undefined)?.toLowerCase()
	if (fromEnv && fromEnv in LEVEL_ORDER) return fromEnv as LogLevel
	return isDev ? 'debug' : 'info'
}

let activeLevel: LogLevel = resolveActiveLevel()
let dbSinkEnabled = isServer

function shouldEmit(level: LogLevel): boolean {
	return LEVEL_ORDER[level] >= LEVEL_ORDER[activeLevel]
}

function format(level: LogLevel, message: string, context?: Record<string, unknown>): unknown[] {
	const ts = new Date().toISOString()
	const head = `${ts} ${level.toUpperCase()} ${message}`
	return context !== undefined ? [head, context] : [head]
}

function emitConsole(level: LogLevel, message: string, context?: Record<string, unknown>): void {
	const args = format(level, message, context)
	if (level === 'error') console.error(...args)
	else if (level === 'warn') console.warn(...args)
	else if (level === 'info') console.info(...args)
	else console.debug(...args)
}

/**
 * Normalize a context object for JSON storage. Errors don't serialize cleanly via
 * JSON.stringify (`{}`), so we lift `name`/`message`/`stack` into a plain object before
 * insert. Anything that's already a plain object passes through.
 */
function normalizeContext(context?: Record<string, unknown>): Record<string, unknown> | null {
	if (!context) return null
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(context)) {
		if (value instanceof Error) {
			out[key] = { name: value.name, message: value.message, stack: value.stack }
		} else {
			out[key] = value
		}
	}
	return out
}

// ── DB sink: buffered + flushed by timer ─────────────────────────────────────

export type LogEntry = {
	ts: Date
	level: LogLevel
	message: string
	context: Record<string, unknown> | null
}

export type DbSink = (batch: LogEntry[]) => Promise<void>

let dbSinkFn: DbSink | null = null

/**
 * Wire a DB sink. Called once at server bootstrap from `logs-handler.server.ts` after
 * `ensureDatabaseReady` so `app_logs` exists before the first flush. Browser builds never
 * call this — keeping the registration on the server side is what lets `logger.ts` stay
 * free of any reference to `logs.server.ts`. `null` unregisters it (tests).
 */
export function registerDbSink(fn: DbSink | null): void {
	dbSinkFn = fn
	if (fn && dbSinkEnabled) scheduleFlush()
}

const FLUSH_INTERVAL_MS = 2_000
const FLUSH_MAX_BUFFER = 50
const buffer: LogEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushing = false

/**
 * A failed flush pauses the sink instead of switching it off. It used to set
 * `dbSinkEnabled = false` for the rest of the process, and nothing turned it back on, so one
 * Postgres restart left `app_logs` (and the /review Logs panel) silent until the app was
 * restarted — quiet exactly when things had gone wrong. Now the sink waits and tries again,
 * doubling the wait after each failure in a row, and entries logged meanwhile are kept (up
 * to a cap, oldest dropped first) and saved once the database answers. The batch that
 * failed goes to the console, as before; it is not retried, in case it is what failed.
 */
type RetryPolicy = { baseMs: number; maxMs: number; bufferMax: number }
const DEFAULT_RETRY_POLICY: RetryPolicy = { baseMs: 5_000, maxMs: 5 * 60_000, bufferMax: 1_000 }
let retryPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY }
let consecutiveFailures = 0
let pausedUntil = 0
// Entries that never reached the database: a failed batch, or ones the cap pushed out.
let unsavedCount = 0

/** Tune the retry policy. Mainly for tests; a partial policy keeps the other defaults. */
export function configureDbSinkRetry(policy: Partial<RetryPolicy> | null): void {
	retryPolicy = { ...DEFAULT_RETRY_POLICY, ...(policy ?? {}) }
}

function scheduleFlush(): void {
	if (!dbSinkEnabled || flushTimer || flushing) return
	const wait = Math.max(FLUSH_INTERVAL_MS, pausedUntil - Date.now())
	flushTimer = setTimeout(() => {
		flushTimer = null
		void flushBuffer()
	}, wait)
}

async function flushBuffer(force = false): Promise<void> {
	if (flushing || buffer.length === 0) return
	if (!dbSinkFn) {
		// No sink wired (browser build, or server pre-bootstrap). Drop the queue: the
		// console emit already happened at log time, so the entries aren't lost — just
		// not persisted. The handler will call registerDbSink() once the DB is ready.
		buffer.length = 0
		return
	}
	// Paused after a failure: the timer brings us back when the wait is over.
	if (!force && Date.now() < pausedUntil) return scheduleFlush()
	flushing = true
	const batch = buffer.splice(0, buffer.length)
	const unsavedBefore = unsavedCount
	const notice: LogEntry[] =
		unsavedBefore > 0
			? [
					{
						ts: new Date(),
						level: 'warn',
						message: `[observability/logger] ${unsavedBefore} log entries were not saved while the database was unreachable; they went to the console only`,
						context: { unsaved: unsavedBefore },
					},
				]
			: []
	try {
		await dbSinkFn([...batch, ...notice])
		unsavedCount -= unsavedBefore
		if (consecutiveFailures > 0) {
			console.info(`${new Date().toISOString()} INFO [observability/logger] DB sink recovered; saving logs again`)
		}
		consecutiveFailures = 0
		pausedUntil = 0
	} catch (err) {
		// DB write failed — fall back to console so the entries aren't silently dropped.
		// We DO NOT call emit() here (that would re-buffer). Direct console output only.
		consecutiveFailures++
		const waitMs = Math.min(retryPolicy.baseMs * 2 ** (consecutiveFailures - 1), retryPolicy.maxMs)
		pausedUntil = Date.now() + waitMs
		unsavedCount += batch.length
		const failureNote = err instanceof Error ? err.message : String(err)
		console.error(
			`${new Date().toISOString()} ERROR [observability/logger] DB sink flush failed; emitting batch to console instead, retrying in ${Math.round(waitMs / 1000)}s`,
			{ batchSize: batch.length, consecutiveFailures, error: failureNote },
		)
		for (const entry of batch) {
			emitConsole(entry.level, entry.message, entry.context ?? undefined)
		}
	} finally {
		flushing = false
		// More may have arrived during the await (or while paused) — schedule another tick.
		if (buffer.length > 0) scheduleFlush()
	}
}

function bufferEntry(entry: LogEntry, immediate: boolean): void {
	if (!dbSinkEnabled) return
	buffer.push(entry)
	if (buffer.length > retryPolicy.bufferMax) {
		const overflow = buffer.length - retryPolicy.bufferMax
		buffer.splice(0, overflow)
		unsavedCount += overflow
	}
	if (Date.now() < pausedUntil) {
		scheduleFlush()
	} else if (immediate || buffer.length >= FLUSH_MAX_BUFFER) {
		void flushBuffer()
	} else {
		scheduleFlush()
	}
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
	if (!shouldEmit(level)) return
	emitConsole(level, message, context)
	if (isServer) {
		bufferEntry(
			{
				ts: new Date(),
				level,
				message,
				context: normalizeContext(context),
			},
			level === 'error',
		)
	}
}

export const logger = {
	debug(message: string, context?: Record<string, unknown>): void {
		emit('debug', message, context)
	},
	info(message: string, context?: Record<string, unknown>): void {
		emit('info', message, context)
	},
	warn(message: string, context?: Record<string, unknown>): void {
		emit('warn', message, context)
	},
	error(message: string, context?: Record<string, unknown>): void {
		emit('error', message, context)
	},
	/**
	 * Override the active log level at runtime. Mainly for tests; production reads from
	 * `LOG_LEVEL` (or `NODE_ENV`-derived default) at module load.
	 */
	setLevel(level: LogLevel): void {
		activeLevel = level
	},
	getLevel(): LogLevel {
		return activeLevel
	},
	/**
	 * Toggle DB persistence. Off by default in browser context. Tests turn it off so they
	 * don't write to the dev DB; the bootstrap path turns it on once `app_logs` exists.
	 * Turning it on also ends a pause left by a failed flush, so the next flush tries at once.
	 */
	setDbSinkEnabled(enabled: boolean): void {
		dbSinkEnabled = enabled && isServer
		if (enabled) {
			consecutiveFailures = 0
			pausedUntil = 0
			// A timer set for the end of the pause would otherwise hold the next flush back.
			if (flushTimer) clearTimeout(flushTimer)
			flushTimer = null
			scheduleFlush()
		}
	},
	/**
	 * Force a synchronous flush — useful before the process exits so a graceful shutdown
	 * doesn't drop the last batch. Tries even while paused after a failure. Idempotent; a
	 * no-op if the buffer is empty.
	 */
	async flush(): Promise<void> {
		await flushBuffer(true)
	},
}

export type Logger = typeof logger
