import { registerJobHandler } from '$lib/jobs/worker.server'
import { registerScheduledJob } from '$lib/jobs/scheduler.server'
import { extractSource, insertAppLogBatch, purgeOldLogs } from './logs.server'
import { logger, registerDbSink, type LogEntry } from './logger'

/**
 * Registers the daily `app_logs_purge` job + retention schedule, and turns on the logger's
 * DB sink. Called from db.server.ts after `ensureDatabaseReady` completes so the
 * `app_logs` table exists before the first flush.
 *
 * Retention default: 14 days. Override with `APP_LOGS_RETENTION_DAYS` if needed (e.g. on a
 * resource-constrained host where 14d is too noisy).
 */

const DAY_MS = 24 * 60 * 60 * 1000
const PURGE_INTERVAL_MS = DAY_MS
const DEFAULT_RETENTION_DAYS = 14

let registered = false

function resolveRetentionDays(): number {
	const raw = process.env.APP_LOGS_RETENTION_DAYS?.trim()
	if (!raw) return DEFAULT_RETENTION_DAYS
	const parsed = Number.parseInt(raw, 10)
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 365) return DEFAULT_RETENTION_DAYS
	return parsed
}

export function registerLogsJobHandlers(): void {
	if (registered) return

	const retentionDays = resolveRetentionDays()

	registerJobHandler('app_logs_purge', async () => {
		const result = await purgeOldLogs(retentionDays)
		return { deleted: result.deleted, retentionDays, purgedAt: new Date().toISOString() }
	})

	registerScheduledJob({
		name: 'app_logs_purge.daily',
		intervalMs: PURGE_INTERVAL_MS,
		// Don't run on boot — wait an hour so a fresh deploy doesn't immediately purge logs
		// the operator might want to inspect after restart.
		initialDelayMs: 60 * 60 * 1000,
		enqueue: () => {
			// Daily bucket so re-fires within the same UTC day collapse on (type, dedupeKey).
			const dayBucket = Math.floor(Date.now() / DAY_MS)
			return {
				type: 'app_logs_purge',
				queue: 'maintenance',
				priority: 10,
				dedupeKey: `app_logs_purge:${dayBucket}`,
				payload: {},
			}
		},
	})

	// Wire the logger's DB sink. logger.ts has no static or dynamic reference to
	// logs.server.ts — this is the single point where the two halves are joined, and it
	// only runs on the server. Browser builds never reach this file (it's *.server.ts), so
	// the sink stays unregistered there and `flushBuffer` no-ops.
	registerDbSink(async (batch: LogEntry[]) => {
		await insertAppLogBatch(
			batch.map((entry) => {
				const { source } = extractSource(entry.message)
				return {
					ts: entry.ts,
					level: entry.level,
					message: entry.message,
					context: entry.context,
					source,
				}
			}),
		)
	})

	// Now that the table exists and the retention job is registered, enable the DB sink so
	// subsequent log lines persist. (The sink starts on by default for cold starts where this
	// handler is the first thing to run; calling here is a safety net for the case where the
	// sink was disabled earlier by a flush failure during pre-migration writes.)
	logger.setDbSinkEnabled(true)

	registered = true
}
