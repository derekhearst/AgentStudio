import { registerJobHandler } from '$lib/jobs/worker.server'
import { registerScheduledJob } from '$lib/jobs/scheduler.server'
import { reapStuckRuns } from './runs.server'

/**
 * `runs_reap` job handler + scheduled tick.
 *
 * Sweeps `chat_runs` rows that are stuck in active states (queued / running /
 * waiting_tool_approval / waiting_user_input) with an `updatedAt` older than 1 hour. These
 * are runs whose runtime poll loop died — process restart, crash, network blip — leaving the
 * row "live" forever. The reaper marks them as canceled so the user's recent-chats list and
 * the running-sessions dock stop showing perpetual "Waiting for you" badges.
 *
 * DedupeKey `runs_reap:5min:<bucket>` so re-fires within the same 5-minute tick collapse on
 * the (type, dedupeKey) unique. Priority 10 (maintenance) so it never preempts user-facing
 * work. Best-effort: failures are caught and logged, never throw upstream.
 */

const REAP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

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
		// Wait a minute past boot so the in-process runtime has time to register heartbeats on
		// any runs the previous process left mid-flight before we sweep them. A fresh deploy
		// that genuinely lost runs will pick those up on the next tick (5 minutes later).
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
