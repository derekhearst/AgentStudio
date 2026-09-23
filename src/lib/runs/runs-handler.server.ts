import { registerJobHandler } from '$lib/jobs/worker.server'
import { registerScheduledJob } from '$lib/jobs/scheduler.server'
import { reapStuckRuns } from './runs.server'
import { closeStalePromptReviewItems } from './prompt-review-items.server'
import { logger } from '$lib/observability/logger'

/**
 * Registers the `runs_reap` job + 5-min schedule. See `reapStuckRuns` for behavior. The same
 * tick closes review-inbox approval and question items whose run stopped waiting without
 * closing them (see `closeStalePromptReviewItems`) — a reaped run is the usual case.
 */

const REAP_INTERVAL_MS = 5 * 60 * 1000

let registered = false

export function registerRunsJobHandlers(): void {
	if (registered) return

	registerJobHandler('runs_reap', async () => {
		try {
			const summary = await reapStuckRuns()
			if (summary.reapedCount > 0) {
				logger.info(`[runs-reaper] reaped ${summary.reapedCount} stuck runs`, { reapedIds: summary.reapedIds })
			}
			const closedPrompts = await closeStalePromptReviewItems().catch((err) => {
				logger.warn('[runs-reaper] closing stale prompt review items failed (non-fatal)', { err })
				return 0
			})
			return { reapedCount: summary.reapedCount, closedPrompts, reapedAt: new Date().toISOString() }
		} catch (err) {
			logger.warn('[runs-reaper] reap failed (non-fatal)', { err })
			return { reapedCount: 0, error: err instanceof Error ? err.message : String(err) }
		}
	})

	registerScheduledJob({
		name: 'runs_reap.5min',
		intervalMs: REAP_INTERVAL_MS,
		// One-minute boot delay gives the new runtime a chance to register heartbeats on runs
		// the previous process left mid-flight before the reaper sees them as stale.
		initialDelayMs: 60_000,
		enqueue: () => {
			const bucket = Math.floor(Date.now() / REAP_INTERVAL_MS)
			return {
				type: 'runs_reap',
				queue: 'maintenance',
				priority: 10,
				// Once per window, however many times a restart re-fires the schedule inside it.
				dedupeKey: `runs_reap:5min:${bucket}`,
				dedupeScope: 'forever',
				payload: {},
			}
		},
	})

	registered = true
}
