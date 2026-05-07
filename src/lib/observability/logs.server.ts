import { and, desc, eq, gte, ilike, lt, or, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { appLogs, type AppLogRow, type LogLevel } from './observability.schema'
import { users } from '$lib/auth/auth.schema'

/**
 * App-log persistence helpers — paired with `logger.ts`.
 *
 * The logger buffers entries in-memory and calls `insertAppLogBatch` on flush. Reads come
 * from `listAppLogs` for the /observability/logs page. `purgeOldLogs` is the retention
 * job's worker.
 *
 * NEVER log from inside this module — that would create a feedback loop with the logger.
 * Failures must throw so the logger's catch block can fall back to console.
 */

export type AppLogInsert = {
	ts?: Date
	level: LogLevel
	message: string
	context?: Record<string, unknown> | null
	source?: string | null
	userId?: string | null
}

const SOURCE_PREFIX_RE = /^\[([^\]]{1,80})\]\s*/

/**
 * Lift the leading `[domain]` prefix off a log message and return the bare message + source.
 * The on-the-wire message keeps the prefix (so console output is unchanged); the DB row
 * also stores the source separately so /observability/logs can filter per-domain without
 * pattern-matching message strings.
 */
export function extractSource(message: string): { source: string | null; message: string } {
	const match = SOURCE_PREFIX_RE.exec(message)
	if (!match) return { source: null, message }
	return { source: match[1], message }
}

export async function insertAppLogBatch(rows: AppLogInsert[]): Promise<void> {
	if (rows.length === 0) return
	const now = new Date()
	await db.insert(appLogs).values(
		rows.map((row) => ({
			ts: row.ts ?? now,
			level: row.level,
			message: row.message,
			context: row.context ?? null,
			source: row.source ?? null,
			userId: row.userId ?? null,
		})),
	)
}

export type ListAppLogsFilters = {
	level?: LogLevel
	/** Min level — return rows at this severity or above (e.g. 'warn' returns warn + error). */
	minLevel?: LogLevel
	source?: string
	search?: string
	sinceISO?: string
	limit?: number
}

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
}

export async function listAppLogs(filters: ListAppLogsFilters = {}): Promise<{
	logs: Array<AppLogRow & { username: string | null }>
}> {
	const conds = []
	if (filters.level) conds.push(eq(appLogs.level, filters.level))
	if (filters.minLevel) {
		const allowed = (Object.keys(LEVEL_ORDER) as LogLevel[]).filter(
			(l) => LEVEL_ORDER[l] >= LEVEL_ORDER[filters.minLevel!],
		)
		// inArray with the small fixed enum keeps the query simple and indexable.
		conds.push(or(...allowed.map((l) => eq(appLogs.level, l)))!)
	}
	if (filters.source) conds.push(eq(appLogs.source, filters.source))
	if (filters.search) {
		const needle = `%${filters.search}%`
		conds.push(
			or(
				ilike(appLogs.message, needle),
				// JSONB → text cast lets us search inside the structured context. Slow on big
				// tables (no index) but the retention window keeps the row count bounded; if it
				// becomes hot we can switch to a generated tsvector column.
				sql`${appLogs.context}::text ILIKE ${needle}`,
			)!,
		)
	}
	if (filters.sinceISO) conds.push(gte(appLogs.ts, new Date(filters.sinceISO)))

	const rows = await db
		.select({
			id: appLogs.id,
			ts: appLogs.ts,
			level: appLogs.level,
			message: appLogs.message,
			context: appLogs.context,
			source: appLogs.source,
			userId: appLogs.userId,
			username: users.username,
		})
		.from(appLogs)
		.leftJoin(users, eq(users.id, appLogs.userId))
		.where(conds.length > 0 ? and(...conds) : undefined)
		.orderBy(desc(appLogs.ts))
		.limit(Math.min(filters.limit ?? 200, 1000))

	return { logs: rows }
}

/**
 * Drop rows older than `retentionDays`. Returns the number of rows removed for the
 * scheduled job's lifecycle metric.
 */
export async function purgeOldLogs(retentionDays: number): Promise<{ deleted: number }> {
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
	const result = await db.delete(appLogs).where(lt(appLogs.ts, cutoff)).returning({ id: appLogs.id })
	return { deleted: result.length }
}

/**
 * Per-source row counts for the last `windowMs` — backs the /observability/logs sidebar
 * so an operator can see at a glance which domains are noisy.
 */
export async function countLogsBySource(windowMs: number): Promise<Array<{ source: string | null; count: number }>> {
	const cutoff = new Date(Date.now() - windowMs)
	const rows = await db
		.select({
			source: appLogs.source,
			count: sql<number>`count(*)::int`,
		})
		.from(appLogs)
		.where(gte(appLogs.ts, cutoff))
		.groupBy(appLogs.source)
		.orderBy(desc(sql`count(*)`))
	return rows
}
