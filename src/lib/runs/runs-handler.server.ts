import { registerJobHandler } from '$lib/jobs/worker.server'
import { registerScheduledJob } from '$lib/jobs/scheduler.server'
import { reapStuckRuns } from './runs.server'

/**
 * Registers the `runs_reap` job + 5-min schedule. See `reapStuckRuns` for behavior.
 */

const REAP_INTERVAL_MS = 5 * 60 * 1000

let registered = false

export function registerRunsJobHandlers(): void {
	if (registered) return

	registerJobHandler('runs_reap', async () => {
		try {
			const summary = await reapStuckRuns()
			if (summary.reapedCount > 0) {
				console.info(`[runs-reaper] reaped ${summary.reapedCount} stuck runs:`, summary.reapedIds)
			}
			return { reapedCount: summary.reapedCount, reapedAt: new Date().toISOString() }
		} catch (err) {
			console.warn('[runs-reaper] reap failed (non-fatal):', err)
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
				dedupeKey: `runs_reap:5min:${bucket}`,
				payload: {},
			}
		},
	})

	registered = true
}
