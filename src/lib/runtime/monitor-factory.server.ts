/**
 * Factory for the polling-snapshot SSE monitor endpoints.
 *
 * Two endpoints — `/api/agents/monitor` and `/api/chat/monitor` — were
 * byte-identical except for which `listActiveXxxRunsForUser` they invoke.
 * This factory consolidates the loop, abort handling, and SSE plumbing so the
 * route files become a one-liner.
 */

import type { RequestHandler } from '@sveltejs/kit'
import { encodeSseData } from '$lib/runtime/sse-codec'
import { logger } from '$lib/observability/logger'

const POLL_INTERVAL_MS = 700

export type SseMonitorOptions = {
	/** How often to poll. Default 700ms. */
	pollIntervalMs?: number
}

export function createSseMonitorHandler<T>(
	fetchSnapshot: (userId: string) => Promise<T>,
	options: SseMonitorOptions = {},
): RequestHandler {
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS

	return ({ request, locals }) => {
		if (!locals.user) {
			return new Response('Unauthorized', { status: 401 })
		}

		const userId = locals.user.id
		let intervalId: ReturnType<typeof setInterval> | undefined
		let closed = false
		let polling = false
		let failing = false

		const stop = () => {
			closed = true
			if (intervalId) clearInterval(intervalId)
		}

		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				/**
				 * Runs from a timer with nobody awaiting it, so it must never reject. Under Bun an
				 * unhandled rejection exits the process — and this poll runs for every open tab
				 * (the sidebar opens it on every page), so one dropped database connection used to
				 * take the whole server down with every agent run and stream in it.
				 *
				 * A failed poll is skipped, not fatal: the next tick tries again, and the stream
				 * stays open, because the browser's EventSource gives up for good when a
				 * reconnect is answered with an error, and nothing on the page reopens it. The
				 * failure is logged once when it starts and once when it clears, not per tick.
				 *
				 * One query at a time: a slow database skips ticks instead of stacking a new
				 * query every 700ms behind the ones still waiting.
				 */
				const emitSnapshot = async () => {
					if (closed || polling) return
					polling = true
					try {
						const snapshot = await fetchSnapshot(userId)
						if (failing) {
							failing = false
							logger.info('[monitor] snapshot polling recovered', { userId })
						}
						if (closed) return
						try {
							controller.enqueue(encodeSseData(snapshot))
						} catch {
							// The client went away between ticks.
							stop()
						}
					} catch (err) {
						if (!failing) {
							failing = true
							logger.warn('[monitor] snapshot poll failed; retrying on the next tick', {
								userId,
								error: err instanceof Error ? err.message : String(err),
							})
						}
					} finally {
						polling = false
					}
				}

				void emitSnapshot()
				intervalId = setInterval(() => {
					void emitSnapshot()
				}, pollIntervalMs)

				request.signal.addEventListener('abort', () => {
					stop()
					try {
						controller.close()
					} catch {
						// Already closed.
					}
				})
			},
			cancel() {
				stop()
			},
		})

		return new Response(readable, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
		})
	}
}
