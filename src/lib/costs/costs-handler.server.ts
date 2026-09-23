import { registerJobHandler } from '$lib/jobs/worker.server'
import { registerScheduledJob } from '$lib/jobs/scheduler.server'
import { reconcilePendingVideoJobs } from './media-spend.server'

/**
 * Registers the `video_cost_reconcile` job + 10-minute schedule.
 *
 * A video job the tool stopped waiting for is still billed when it finishes. The poll route
 * records that cost if someone polls it; this records it when nobody does. See
 * `reconcilePendingVideoJobs`. Maintenance priority, and deduped per 10-minute window so a
 * slow tick cannot stack up runs.
 */

const VIDEO_COST_RECONCILE_INTERVAL_MS = 10 * 60 * 1000

let registered = false

export function registerCostJobHandlers(): void {
	if (registered) return

	registerJobHandler('video_cost_reconcile', async () => {
		const summary = await reconcilePendingVideoJobs()
		return { ...summary, reconciledAt: new Date().toISOString() }
	})

	registerScheduledJob({
		name: 'video_cost_reconcile.10min',
		intervalMs: VIDEO_COST_RECONCILE_INTERVAL_MS,
		initialDelayMs: 2 * 60 * 1000,
		enqueue: () => {
			const bucket = Math.floor(Date.now() / VIDEO_COST_RECONCILE_INTERVAL_MS)
			return {
				type: 'video_cost_reconcile',
				queue: 'maintenance',
				priority: 10,
				dedupeKey: `video_cost_reconcile:10min:${bucket}`,
				payload: {},
			}
		},
	})

	registered = true
}
