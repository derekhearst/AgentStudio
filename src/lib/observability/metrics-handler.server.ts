import { registerJobHandler } from '$lib/jobs/worker.server'
import { registerScheduledJob } from '$lib/jobs/scheduler.server'
import { runMetricsSample } from './metrics.server'

/**
 * Wave 5 #20 phase 4 — `metrics_sample` job handler + 5min schedule.
 *
 * Periodically snapshots queue depth, review-inbox open counts, and run terminal counts
 * into `operational_metrics`. The `/review/health` page reads the most-recent value per
 * (metric, dimension) pair so an admin gets a point-in-time platform overview.
 *
 * DedupeKey `metrics:5min:<5minBucket>` so a stalled tick that fires twice within the same
 * 5min window collapses to one job. Runs as priority 10 (maintenance) so it never preempts
 * user-facing work.
 */

const METRICS_SAMPLE_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

let registered = false

export function registerMetricsJobHandlers(): void {
	if (registered) return

	registerJobHandler('metrics_sample', async () => {
		const summary = await runMetricsSample()
		return { written: summary.written, sampledAt: new Date().toISOString() }
	})

	registerScheduledJob({
		name: 'metrics_sample.5min',
		intervalMs: METRICS_SAMPLE_INTERVAL_MS,
		// First sample shortly after boot so a fresh deploy has data within a minute.
		initialDelayMs: 45_000,
		enqueue: () => {
			// 5min bucket so re-fires in the same window collapse on the (type, dedupeKey) unique.
			const bucket = Math.floor(Date.now() / METRICS_SAMPLE_INTERVAL_MS)
			return {
				type: 'metrics_sample',
				queue: 'maintenance',
				priority: 10,
				dedupeKey: `metrics:5min:${bucket}`,
				payload: {},
			}
		},
	})

	registered = true
}
