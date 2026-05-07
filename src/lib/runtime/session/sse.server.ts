import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns, type StreamBlock } from '$lib/runs/runs.schema'
import { appendRunEvent } from '$lib/runs/events.server'
import { persistRunBlocks } from '$lib/runs/blocks.server'
import { encodeSseFrame } from '../sse-codec'
import type { RunPatch, Session } from '../types'
import { logger } from '$lib/observability/logger'

/**
 * Wave 2 #10 phase 1 — SSE-backed Session.
 *
 * Wraps a ReadableStream controller AND the durable run-state writes (run_events, chat_runs,
 * stream_blocks). The chat-stream `+server.ts` builds one of these and hands it to the loop.
 *
 * Three responsibilities:
 *   1. Encode + enqueue SSE frames (with optional event sequence numbers for resumability).
 *   2. Persist non-noisy events to `run_events` (skipping per-token `delta` / `reasoning`).
 *   3. Coalesce heartbeat-only chat_runs writes (>1 per second) so we don't hammer the row.
 */

const NON_PERSISTED_EVENTS = new Set(['delta', 'reasoning'])

export type SseSessionOptions = {
	runId: string
	controller: ReadableStreamDefaultController<Uint8Array>
}

export function createSseSession(opts: SseSessionOptions): Session & {
	/** Internal stream-block buffer mirrored to chat_runs.stream_blocks per push. */
	readonly streamBlocks: StreamBlock[]
	/** Set false by the safe-controller wrapper if the client disconnects mid-stream. */
	disconnect(): void
	/**
	 * Duck-typed safe controller wrapper for legacy callers (runInlineSubagent) that take a
	 * `ReadableStreamDefaultController<Uint8Array>` directly. Shares the same `clientConnected`
	 * flag as the Session so a disconnect propagates to both surfaces.
	 */
	readonly safeController: ReadableStreamDefaultController<Uint8Array>
} {
	let clientConnected = true
	let lastHeartbeatWriteAt = 0
	const streamBlocks: StreamBlock[] = []

	const safeEnqueue = (chunk: Uint8Array) => {
		if (!clientConnected) return
		try {
			opts.controller.enqueue(chunk)
		} catch {
			clientConnected = false
		}
	}

	const safeController = {
		enqueue(chunk: Uint8Array) {
			safeEnqueue(chunk)
		},
	} as ReadableStreamDefaultController<Uint8Array>

	return {
		runId: opts.runId,
		streamBlocks,
		safeController,
		isClientConnected() {
			return clientConnected
		},
		disconnect() {
			clientConnected = false
		},
		async emit(eventName, payload) {
			let seq: number | undefined
			if (!NON_PERSISTED_EVENTS.has(eventName)) {
				try {
					seq = await appendRunEvent(opts.runId, eventName, payload)
				} catch (err) {
					logger.error('[runtime/sse] failed to log run event', {
						runId: opts.runId,
						eventName,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			safeEnqueue(encodeSseFrame(eventName, payload, seq))
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
