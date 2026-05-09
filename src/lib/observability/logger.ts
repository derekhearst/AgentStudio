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
 * insert falls back to console and never blocks the call site. Browser callers (the logger
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
 * free of any reference to `logs.server.ts`.
 */
export function registerDbSink(fn: DbSink): void {
	dbSinkFn = fn
	if (dbSinkEnabled) scheduleFlush()
}

const FLUSH_INTERVAL_MS = 2_000
const FLUSH_MAX_BUFFER = 50
const buffer: LogEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushing = false

function scheduleFlush(): void {
	if (!dbSinkEnabled || flushTimer || flushing) return
	flushTimer = setTimeout(() => {
		flushTimer = null
		void flushBuffer()
	}, FLUSH_INTERVAL_MS)
}

async function flushBuffer(): Promise<void> {
	if (flushing || buffer.length === 0) return
	if (!dbSinkFn) {
		// No sink wired (browser build, or server pre-bootstrap). Drop the queue: the
		// console emit already happened at log time, so the entries aren't lost — just
		// not persisted. The handler will call registerDbSink() once the DB is ready.
		buffer.length = 0
		return
	}
	flushing = true
	const batch = buffer.splice(0, buffer.length)
	try {
		await dbSinkFn(batch)
	} catch (err) {
		// DB write failed — fall back to console so the entries aren't silently dropped.
		// We DO NOT call emit() here (that would re-buffer). Direct console output only.
		const failureNote = err instanceof Error ? err.message : String(err)
		console.error(
			`${new Date().toISOString()} ERROR [observability/logger] DB sink flush failed; emitting batch to console instead`,
			{ batchSize: batch.length, error: failureNote },
		)
		for (const entry of batch) {
			emitConsole(entry.level, entry.message, entry.context ?? undefined)
		}
		// Disable the sink for the rest of the process so subsequent errors don't keep
		// bouncing through the catch block. Operators can re-enable via setDbSinkEnabled(true)
		// after fixing the DB; the next log line will retry.
		dbSinkEnabled = false
	} finally {
		flushing = false
		// More may have arrived during the await — schedule another tick if so.
		if (buffer.length > 0) scheduleFlush()
	}
}

function bufferEntry(entry: LogEntry, immediate: boolean): void {
	if (!dbSinkEnabled) return
	buffer.push(entry)
	if (immediate || buffer.length >= FLUSH_MAX_BUFFER) {
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
	 */
	setDbSinkEnabled(enabled: boolean): void {
		dbSinkEnabled = enabled && isServer
		if (enabled) scheduleFlush()
	},
	/**
	 * Force a synchronous flush — useful before the process exits so a graceful shutdown
	 * doesn't drop the last batch. Idempotent; a no-op if the buffer is empty.
	 */
	async flush(): Promise<void> {
		await flushBuffer()
	},
}

export type Logger = typeof logger
