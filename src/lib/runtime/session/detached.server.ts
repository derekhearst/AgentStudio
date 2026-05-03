import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns, type StreamBlock } from '$lib/runs/runs.schema'
import { appendRunEvent } from '$lib/runs/events.server'
import { persistRunBlocks } from '$lib/runs/blocks.server'
import type { RunPatch, Session } from '../types'

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
				console.error('[runtime/detached] failed to log run event', {
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

			await db.update(chatRuns).set(values).where(eq(chatRuns.id, opts.runId))
			if (patch.heartbeat || patch.state === 'running') {
				lastHeartbeatWriteAt = now
			}
		},
		async pushBlock(block) {
			streamBlocks.push(block)
			await persistRunBlocks(opts.runId, streamBlocks)
		},
	}
}
