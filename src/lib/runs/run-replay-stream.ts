/**
 * The body of `GET /chat/[id]/stream/resume`: replay a run's persisted events after a
 * sequence number, then follow the run until it ends.
 *
 * Following means polling — the events table and the run's state, every `pollIntervalMs` —
 * and the poll has to stop when the client goes away. It used to notice that only when an
 * `enqueue` threw, which needs an event to send, and `delta`, `reasoning` and `tool_progress`
 * are never persisted. So a client that resumed and then closed the tab during a half-hour
 * build left two queries running every half second for the rest of the run, and each of the
 * consumer's retries added another such loop. `cancel` and the request's abort signal now end
 * the loop, and a pending wait is cut short rather than slept out.
 *
 * The database is behind `source` so a spec can drive the loop without one. Imports are
 * relative for the same reason.
 */

import { encodeSseFrame } from '../runtime/sse-codec'

export type ReplayEvent = { seq: number; type: string; payload: unknown }

export type ReplaySource = {
	/** Persisted events with `seq > after`, in order. */
	eventsAfter(after: number): Promise<ReplayEvent[]>
	/** Whether the run is still live. */
	isActive(): Promise<boolean>
}

export function createRunReplayStream(input: {
	since: number
	/** Whether the run was live when the request arrived; a finished run is replayed and closed. */
	activeAtStart: boolean
	source: ReplaySource
	pollIntervalMs: number
	/** The request's abort signal, where the platform provides one. */
	signal?: AbortSignal
	onReplayError?: (error: unknown) => void
}): ReadableStream<Uint8Array> {
	let connected = true
	/** Wakes a pending wait early, so a departed client does not cost one more poll. */
	let wake: (() => void) | null = null
	const disconnect = () => {
		connected = false
		wake?.()
	}
	const pause = (ms: number) =>
		new Promise<void>((resolve) => {
			const timer = setTimeout(done, ms)
			function done() {
				clearTimeout(timer)
				wake = null
				resolve()
			}
			wake = done
		})

	input.signal?.addEventListener('abort', disconnect, { once: true })

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const enqueue = (chunk: Uint8Array) => {
				if (!connected) return
				try {
					controller.enqueue(chunk)
				} catch {
					connected = false
				}
			}
			const close = () => {
				if (!connected) return
				try {
					controller.close()
				} catch {
					// Cancelled between the check and the close.
				}
			}

			let lastSeq = input.since
			const forward = (events: ReplayEvent[]) => {
				for (const ev of events) {
					enqueue(encodeSseFrame(ev.type, ev.payload, ev.seq))
					lastSeq = ev.seq
				}
			}

			// Replay what the client missed.
			try {
				forward(await input.source.eventsAfter(lastSeq))
			} catch (error) {
				input.onReplayError?.(error)
				enqueue(encodeSseFrame('done', { error: 'Resume replay failed' }))
				close()
				return
			}

			// A run that had already ended gets a synthetic `done` and nothing more.
			if (!input.activeAtStart) {
				enqueue(encodeSseFrame('done', { resumed: true, terminal: true }))
				close()
				return
			}

			// Follow the run until it ends, or until nobody is listening.
			while (connected) {
				forward(await input.source.eventsAfter(lastSeq))
				if (!connected) break

				if (!(await input.source.isActive())) {
					// Drain whatever landed between the last poll and the state flip.
					if (connected) forward(await input.source.eventsAfter(lastSeq))
					break
				}

				await pause(input.pollIntervalMs)
			}

			close()
		},
		cancel() {
			disconnect()
		},
	})
}
