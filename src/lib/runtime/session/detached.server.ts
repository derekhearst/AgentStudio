import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns, type StreamBlock } from '$lib/runs/runs.schema'
import { appendRunEvent } from '$lib/runs/events.server'
import { persistRunBlocks } from '$lib/runs/blocks.server'
import type { RunPatch, Session } from '../types'
import { logger } from '$lib/observability/logger'

/**
 * Wave 2 #10 phase 6 — detached Session.
 *
 * For runs that aren't attached to a live SSE stream — automations on a cron tick, scheduled
 * background tasks, future task-runner workers. Writes to `run_events` (so the run trace + the
 * stream/.../resume endpoint can replay events later) and to `chat_runs` (state, lastDelta,
 * heartbeat) but never to a controller.
 *
 * Same heartbeat coalescing as the SSE-backed Session so we don't hammer the row.
 */

const NON_PERSISTED_EVENTS = new Set(['delta', 'reasoning'])

export type DetachedSessionOptions = {
	runId: string
}

export function createDetachedSession(opts: DetachedSessionOptions): Session & {
	readonly streamBlocks: StreamBlock[]
} {
	let lastHeartbeatWriteAt = 0
	const streamBlocks: StreamBlock[] = []

	return {
		runId: opts.runId,
		streamBlocks,
		isClientConnected() {
			// Detached sessions never have a client to connect; loop callers should treat the
			// run as "always connected" so they don't shortcut tool execution.
			return true
		},
		async emit(eventName, payload) {
			if (NON_PERSISTED_EVENTS.has(eventName)) return
			try {
				await appendRunEvent(opts.runId, eventName, payload)
			} catch (err) {
				logger.error('[runtime/detached] failed to log run event', {
					runId: opts.runId,
					eventName,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		},
		async updateRun(patch: RunPatch) {
			const now = Date.now()
			if (
				patch.heartbeat &&
				!patch.state &&
				patch.label === undefined &&
				patch.lastDelta === undefined &&
				patch.error === undefined &&
				now - lastHeartbeatWriteAt < 1000
			) {
				return
			}

			const values: Partial<typeof chatRuns.$inferInsert> = { updatedAt: new Date(now) }
			if (patch.state) values.state = patch.state
			if (patch.label !== undefined) values.label = patch.label
			if (patch.lastDelta !== undefined) values.lastDelta = patch.lastDelta
			if (patch.error !== undefined) values.error = patch.error
			if (patch.heartbeat || patch.state === 'running') values.lastHeartbeatAt = new Date(now)
			if (patch.finished) values.finishedAt = new Date(now)

			const [updated] = await db
				.update(chatRuns)
				.set(values)
				.where(eq(chatRuns.id, opts.runId))
				.returning({
					state: chatRuns.state,
					source: chatRuns.source,
					startedAt: chatRuns.startedAt,
					finishedAt: chatRuns.finishedAt,
				})
			if (patch.heartbeat || patch.state === 'running') {
				lastHeartbeatWriteAt = now
			}

			// Wave 5 #20 phase 4 — emit run lifecycle metrics on terminal transitions. Best-effort
			// dynamic import keeps this path free of an observability cycle. Only fires once per
			// run finish (caller passes `finished: true` exactly once).
			if (patch.finished && updated && (updated.state === 'completed' || updated.state === 'failed' || updated.state === 'canceled')) {
				void (async () => {
					try {
						const { recordMetric } = await import('$lib/observability/metrics.server')
						const startedAt = updated.startedAt ? new Date(updated.startedAt).getTime() : null
						const finishedAt = updated.finishedAt ? new Date(updated.finishedAt).getTime() : now
						const durationMs = startedAt != null ? Math.max(0, finishedAt - startedAt) : 0
						await recordMetric({
							metric: 'runs.duration_ms',
							dimension: { source: updated.source ?? 'unknown', status: updated.state },
							value: durationMs,
						})
						await recordMetric({
							metric: `runs.lifecycle.${updated.state}`,
							dimension: { source: updated.source ?? 'unknown' },
							value: 1,
						})
					} catch (err) {
						logger.warn('[runtime/detached] run lifecycle metric failed (non-fatal)', { err })
					}
				})()
			}
		},
		async pushBlock(block) {
			streamBlocks.push(block)
			await persistRunBlocks(opts.runId, streamBlocks)
		},
	}
}
