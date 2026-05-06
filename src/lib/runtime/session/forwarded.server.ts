import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns, type StreamBlock } from '$lib/runs/runs.schema'
import { appendRunEvent } from '$lib/runs/events.server'
import { persistRunBlocks } from '$lib/runs/blocks.server'
import { encodeSseFrame } from '../sse-codec'
import type { RunPatch, Session } from '../types'

/**
 * Wave 2 #10 phase 5 — forwarded Session for sub-agents.
 *
 * Wraps a PARENT stream's controller with event-name remapping so the loop's `tool_call` /
 * `tool_result` / `delta` / etc. surface in the parent's SSE stream as `subagent_tool_call` /
 * `subagent_tool_result` / `subagent_delta` / etc. The parent UI distinguishes nested events
 * from the orchestrator's own.
 *
 * `updateRun` and `pushBlock` write to the SUB-agent's own chat_runs row — that's what the run
 * trace + resume need; the parent run is independent.
 *
 * Events the sub-agent loop emits that DON'T translate (because the parent doesn't care or the
 * naming is identical) are dropped via `dropOnForward` instead of being remapped.
 */

const NON_PERSISTED_EVENTS = new Set(['delta', 'reasoning'])

/**
 * How the forwarded Session translates the canonical loop event names into sub-agent-prefixed
 * names that the parent UI already knows how to render. Events not in the map are dropped from
 * the parent stream (still persisted to the sub-agent's run_events for forensic visibility).
 */
const FORWARD_MAP: Record<string, string | null> = {
	delta: 'subagent_delta',
	reasoning: null, // sub-agent reasoning isn't surfaced to the parent UI today
	tool_pending: 'subagent_tool_pending',
	tool_call: 'subagent_tool_call',
	tool_result: 'subagent_tool_result',
	tool_denied: 'subagent_tool_denied',
	context_stats: null, // parent has its own context_stats
	compaction: null, // parent doesn't track sub-agent compaction
	ask_user: null, // sub-agents can't reach the user; the loop returns an error inline
	metrics: null, // sub-agent cost rolls up via logLlmUsage instead of an SSE metrics event
}

export type ForwardedSessionOptions = {
	/** Sub-agent's chat_runs.id — events + state writes target this row. */
	runId: string
	/** The PARENT stream's controller. We never close it; the parent owns its lifecycle. */
	parentController: ReadableStreamDefaultController<Uint8Array>
	/**
	 * Optional override of the forward map. Use to add custom translations (e.g. plug a sub-
	 * agent's metrics back into the parent stream as `subagent_metrics`).
	 */
	forwardMap?: Record<string, string | null>
}

export function createForwardedSession(opts: ForwardedSessionOptions): Session & {
	readonly streamBlocks: StreamBlock[]
	disconnect(): void
} {
	let clientConnected = true
	let lastHeartbeatWriteAt = 0
	const streamBlocks: StreamBlock[] = []
	const map = { ...FORWARD_MAP, ...(opts.forwardMap ?? {}) }

	const safeEnqueue = (chunk: Uint8Array) => {
		if (!clientConnected) return
		try {
			opts.parentController.enqueue(chunk)
		} catch {
			clientConnected = false
		}
	}

	return {
		runId: opts.runId,
		streamBlocks,
		isClientConnected() {
			return clientConnected
		},
		disconnect() {
			clientConnected = false
		},
		async emit(eventName, payload) {
			// Persist to the sub-agent's run_events — full forensic trail, even for events we
			// don't forward to the parent.
			if (!NON_PERSISTED_EVENTS.has(eventName)) {
				try {
					await appendRunEvent(opts.runId, eventName, payload)
				} catch (err) {
					console.error('[runtime/forwarded] failed to log run event', {
						runId: opts.runId,
						eventName,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			// Translate + forward to the parent stream, if the event is in the forward map.
			const forwardedName = eventName in map ? map[eventName] : `subagent_${eventName}`
			if (forwardedName) {
				safeEnqueue(encodeSseFrame(forwardedName, payload))
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

			// Wave 5 #20 phase 4 — emit lifecycle metrics on terminal transitions for the sub-agent
			// run. Source dimension naturally splits sub-agent vs orchestrator runs in the dashboard.
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
						console.warn('[runtime/forwarded] run lifecycle metric failed (non-fatal)', err)
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
