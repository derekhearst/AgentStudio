import { expect, test } from '@playwright/test'
import { createRunReplayStream, type ReplayEvent, type ReplaySource } from '../src/lib/runs/run-replay-stream'

/**
 * The body of `stream/resume`, driven without a database.
 *
 * #109 — the tail loop only noticed a departed client when an `enqueue` threw, which needs a
 * persisted event to send. `delta`, `reasoning` and `tool_progress` never are, so a client
 * that resumed and then closed the tab during a long tool call left the loop polling the
 * database twice every half second until the run ended — once per retry the consumer made.
 */

const POLL_MS = 10

/** A run that never ends and never produces anything new: the case the leak needed. */
function silentLiveRun(events: ReplayEvent[] = []) {
	const calls = { eventsAfter: 0, isActive: 0 }
	const source: ReplaySource = {
		eventsAfter: async (after) => {
			calls.eventsAfter++
			return events.filter((e) => e.seq > after)
		},
		isActive: async () => {
			calls.isActive++
			return true
		},
	}
	return { source, calls }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const decode = (chunk: Uint8Array | undefined) => new TextDecoder().decode(chunk)

test('a cancelled reader stops the polling', async () => {
	const { source, calls } = silentLiveRun([{ seq: 1, type: 'tool_call', payload: { id: 't1' } }])
	const stream = createRunReplayStream({ since: 0, activeAtStart: true, source, pollIntervalMs: POLL_MS })
	const reader = stream.getReader()

	// The replay arrives, then the tail starts polling.
	expect(decode((await reader.read()).value)).toContain('event: tool_call')
	await sleep(POLL_MS * 5)
	expect(calls.isActive).toBeGreaterThan(0)

	await reader.cancel()
	await sleep(POLL_MS * 2)
	const settled = { ...calls }
	await sleep(POLL_MS * 10)
	expect(calls).toEqual(settled)
})

test('an aborted request stops the polling too', async () => {
	const { source, calls } = silentLiveRun()
	const controller = new AbortController()
	createRunReplayStream({
		since: 0,
		activeAtStart: true,
		source,
		pollIntervalMs: POLL_MS,
		signal: controller.signal,
	})

	await sleep(POLL_MS * 5)
	expect(calls.eventsAfter).toBeGreaterThan(1)

	controller.abort()
	await sleep(POLL_MS * 2)
	const settled = { ...calls }
	await sleep(POLL_MS * 10)
	expect(calls).toEqual(settled)
})

test('a finished run is replayed from the cursor and closed with a terminal done', async () => {
	const events: ReplayEvent[] = [
		{ seq: 1, type: 'tool_call', payload: {} },
		{ seq: 2, type: 'tool_result', payload: {} },
	]
	const { source } = silentLiveRun(events)
	const stream = createRunReplayStream({ since: 1, activeAtStart: false, source, pollIntervalMs: POLL_MS })
	const text = await new Response(stream).text()

	expect(text).not.toContain('event: tool_call')
	expect(text).toContain('id: 2\nevent: tool_result')
	expect(text).toContain('"terminal":true')
})

test('a live run is followed until it ends, and what landed at the end is drained', async () => {
	const events: ReplayEvent[] = []
	let active = true
	const source: ReplaySource = {
		eventsAfter: async (after) => events.filter((e) => e.seq > after),
		isActive: async () => active,
	}
	const stream = createRunReplayStream({ since: 0, activeAtStart: true, source, pollIntervalMs: POLL_MS })
	const body = new Response(stream).text()

	await sleep(POLL_MS * 3)
	events.push({ seq: 1, type: 'tool_call', payload: {} })
	await sleep(POLL_MS * 3)
	events.push({ seq: 2, type: 'done', payload: { messageId: 'm1' } })
	active = false

	const text = await body
	expect(text).toContain('id: 1\nevent: tool_call')
	expect(text).toContain('id: 2\nevent: done')
})

test('a replay that fails says so and closes', async () => {
	const stream = createRunReplayStream({
		since: 0,
		activeAtStart: true,
		pollIntervalMs: POLL_MS,
		source: {
			eventsAfter: async () => {
				throw new Error('db down')
			},
			isActive: async () => true,
		},
	})
	expect(await new Response(stream).text()).toContain('Resume replay failed')
})
