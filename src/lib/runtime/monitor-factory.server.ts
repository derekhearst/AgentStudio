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

const POLL_INTERVAL_MS = 700

export function createSseMonitorHandler<T>(fetchSnapshot: (userId: string) => Promise<T>): RequestHandler {
	return ({ request, locals }) => {
		if (!locals.user) {
			return new Response('Unauthorized', { status: 401 })
		}

		const userId = locals.user.id
		let intervalId: ReturnType<typeof setInterval> | undefined

		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				const emitSnapshot = async () => {
					const snapshot = await fetchSnapshot(userId)
					try {
						controller.enqueue(encodeSseData(snapshot))
					} catch {
						if (intervalId) clearInterval(intervalId)
					}
				}

				void emitSnapshot()
				intervalId = setInterval(() => {
					void emitSnapshot()
				}, POLL_INTERVAL_MS)

				request.signal.addEventListener('abort', () => {
					if (intervalId) clearInterval(intervalId)
					try {
						controller.close()
					} catch {
						// Already closed.
					}
				})
			},
			cancel() {
				if (intervalId) clearInterval(intervalId)
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
