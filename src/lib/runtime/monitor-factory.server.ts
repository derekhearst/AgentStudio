/**
 * Factory for the polling-snapshot SSE monitor endpoints.
 *
 * Two endpoints — `/api/agents/monitor` and `/api/chat/monitor` — were
 * byte-identical except for which `listActiveXxxRunsForUser` they invoke.
 * This factory consolidates the loop, abort handling, and SSE plumbing so the
 * route files become a one-liner.
 */

import type { RequestHandler } from '@sveltejs/kit'
import { encodeSseData, encodeSseFrame } from '$lib/runtime/sse-codec'

const POLL_INTERVAL_MS = 700
/** The version is read on every third snapshot (~2s): a list catching up is not a live run. */
const VERSION_EVERY_POLLS = 3

export type MonitorVersionSignal = {
	/** The SSE event name. A named event, so a listener on the snapshots never sees it. */
	event: string
	/** A cheap fingerprint of something the page caches; sent only when it changes. */
	read: (userId: string) => Promise<string>
}

export function createSseMonitorHandler<T>(
	fetchSnapshot: (userId: string) => Promise<T>,
	options: { version?: MonitorVersionSignal } = {},
): RequestHandler {
	return ({ request, locals }) => {
		if (!locals.user) {
			return new Response('Unauthorized', { status: 401 })
		}

		const userId = locals.user.id
		let intervalId: ReturnType<typeof setInterval> | undefined
		let lastVersion: string | null = null
		let polls = 0

		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				const emitSnapshot = async () => {
					const snapshot = await fetchSnapshot(userId)
					try {
						controller.enqueue(encodeSseData(snapshot))
					} catch {
						if (intervalId) clearInterval(intervalId)
						return
					}
					if (!options.version || polls++ % VERSION_EVERY_POLLS !== 0) return
					const version = await options.version.read(userId).catch(() => null)
					if (version === null || version === lastVersion) return
					lastVersion = version
					try {
						controller.enqueue(encodeSseFrame(options.version.event, { version }))
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
