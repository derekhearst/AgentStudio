import { expect, test } from '@playwright/test'

/**
 * The SSE monitor poll must survive a failed query.
 *
 * `/api/chat/monitor` (opened by the sidebar on every page) and `/api/agents/monitor` poll the
 * database every 700ms per open tab, from a timer nobody awaits. The query sat outside the
 * handler's try, so a dropped connection became an unhandled rejection — and under Bun that
 * exits the process, taking every agent run and stream in it along.
 *
 * Pure: the snapshot function is a stub, so nothing here touches a database.
 */

type Handler = (event: unknown) => Response | Promise<Response>

function monitorEvent(signal: AbortSignal) {
	return {
		request: new Request('http://localhost/api/chat/monitor', { signal }),
		locals: { user: { id: 'user-1' } },
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test.describe('runtime/monitor-factory — polling that cannot take the server down', () => {
	test('a failed poll is skipped, not thrown: the stream stays open and recovers', async () => {
		const { createSseMonitorHandler } = await import('../src/lib/runtime/monitor-factory.server')
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => unhandled.push(reason)
		process.on('unhandledRejection', onUnhandled)
		const abort = new AbortController()
		try {
			let calls = 0
			const handler = createSseMonitorHandler(
				async () => {
					calls += 1
					if (calls <= 2) throw new Error('Connection terminated unexpectedly')
					return [{ conversationId: 'c1' }]
				},
				{ pollIntervalMs: 20 },
			) as unknown as Handler

			const response = await handler(monitorEvent(abort.signal))
			expect(response.status).toBe(200)
			const reader = response.body!.getReader()
			const { value } = await reader.read()
			expect(new TextDecoder().decode(value)).toBe('data: [{"conversationId":"c1"}]\n\n')
			expect(calls, 'two failed polls came before the frame').toBeGreaterThanOrEqual(3)

			// Give a stray rejection time to surface.
			await sleep(50)
			expect(unhandled).toEqual([])
			await reader.cancel()
		} finally {
			abort.abort()
			process.off('unhandledRejection', onUnhandled)
		}
	})

	test('one query at a time: a slow database skips ticks instead of stacking queries', async () => {
		const { createSseMonitorHandler } = await import('../src/lib/runtime/monitor-factory.server')
		let calls = 0
		let release!: () => void
		const slowQuery = new Promise<void>((resolve) => {
			release = resolve
		})
		const handler = createSseMonitorHandler(
			async () => {
				calls += 1
				await slowQuery
				return []
			},
			{ pollIntervalMs: 10 },
		) as unknown as Handler
		const abort = new AbortController()
		const response = await handler(monitorEvent(abort.signal))
		try {
			await sleep(120)
			expect(calls, 'ten ticks passed while the first query was still out').toBe(1)

			release()
			await sleep(60)
			expect(calls).toBeGreaterThan(1)

			abort.abort()
			const afterAbort = calls
			await sleep(60)
			expect(calls, 'a closed stream stops polling').toBe(afterAbort)
		} finally {
			abort.abort()
			await response.body?.cancel().catch(() => undefined)
		}
	})
})

/** Read the stream until `done` holds for everything read so far. */
async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	done: (text: string) => boolean,
	timeoutMs = 3000,
): Promise<string> {
	const decoder = new TextDecoder()
	const deadline = Date.now() + timeoutMs
	let text = ''
	while (!done(text)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting on the stream; read so far:\n${text}`)
		const { value, done: ended } = await reader.read()
		if (ended) break
		text += decoder.decode(value, { stream: true })
	}
	return text
}

const snapshotFrames = (text: string) => text.match(/^data: \[\]$/gm)?.length ?? 0
const versionFrames = (text: string) => text.match(/^event: conversations\ndata: .*$/gm) ?? []

/**
 * #79 — the chat monitor also tells an open sidebar when the conversation list changed, as a
 * named event carrying a fingerprint. That read rides the same tick as the snapshot, so it
 * must obey the same rules: never reject, one query at a time, nothing sent after close.
 */
test.describe('runtime/monitor-factory — the version signal inside the guarded poll', () => {
	test('a named event on the first tick, then again only when the fingerprint moves', async () => {
		const { createSseMonitorHandler } = await import('../src/lib/runtime/monitor-factory.server')
		let snapshots = 0
		let reads = 0
		const versions = ['v1', 'v1', 'v2']
		const handler = createSseMonitorHandler(
			async () => {
				snapshots += 1
				return []
			},
			{
				pollIntervalMs: 10,
				version: {
					event: 'conversations',
					read: async () => versions[Math.min(reads++, versions.length - 1)],
				},
			},
		) as unknown as Handler
		const abort = new AbortController()
		const response = await handler(monitorEvent(abort.signal))
		const reader = response.body!.getReader()
		try {
			const text = await readUntil(reader, (t) => t.includes('"v2"') && snapshotFrames(t) >= 12)
			expect(text.startsWith('data: []\n\nevent: conversations\ndata: {"version":"v1"}\n\n'), text).toBe(true)
			expect(versionFrames(text), 'an unchanged fingerprint is not re-sent').toEqual([
				'event: conversations\ndata: {"version":"v1"}',
				'event: conversations\ndata: {"version":"v2"}',
			])
			const [seenSnapshots, seenReads] = [snapshots, reads]
			expect(seenReads, 'the fingerprint is read on every third tick, not every tick').toBeLessThanOrEqual(
				Math.ceil(seenSnapshots / 3),
			)
		} finally {
			abort.abort()
			await reader.cancel().catch(() => undefined)
		}
	})

	test('a failing fingerprint read skips the event, and the snapshots carry on', async () => {
		const { createSseMonitorHandler } = await import('../src/lib/runtime/monitor-factory.server')
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => unhandled.push(reason)
		process.on('unhandledRejection', onUnhandled)
		let reads = 0
		const handler = createSseMonitorHandler(async () => [], {
			pollIntervalMs: 10,
			version: {
				event: 'conversations',
				read: async () => {
					reads += 1
					if (reads <= 2) throw new Error('Connection terminated unexpectedly')
					return 'v1'
				},
			},
		}) as unknown as Handler
		const abort = new AbortController()
		const response = await handler(monitorEvent(abort.signal))
		const reader = response.body!.getReader()
		try {
			const text = await readUntil(reader, (t) => versionFrames(t).length > 0)
			expect(snapshotFrames(text), 'the two failed reads cost no snapshots').toBeGreaterThanOrEqual(7)
			expect(versionFrames(text)).toEqual(['event: conversations\ndata: {"version":"v1"}'])

			await sleep(50)
			expect(unhandled).toEqual([])
		} finally {
			abort.abort()
			await reader.cancel().catch(() => undefined)
			process.off('unhandledRejection', onUnhandled)
		}
	})

	test('a slow fingerprint read holds the tick, and a stream closed meanwhile sends nothing', async () => {
		const { createSseMonitorHandler } = await import('../src/lib/runtime/monitor-factory.server')
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => unhandled.push(reason)
		process.on('unhandledRejection', onUnhandled)
		let snapshots = 0
		let release!: () => void
		const slowRead = new Promise<void>((resolve) => {
			release = resolve
		})
		const handler = createSseMonitorHandler(
			async () => {
				snapshots += 1
				return []
			},
			{
				pollIntervalMs: 10,
				version: {
					event: 'conversations',
					read: async () => {
						await slowRead
						return 'v1'
					},
				},
			},
		) as unknown as Handler
		const abort = new AbortController()
		const response = await handler(monitorEvent(abort.signal))
		const reader = response.body!.getReader()
		try {
			await sleep(120)
			expect(snapshots, 'no snapshot query stacks behind the fingerprint read').toBe(1)

			abort.abort()
			release()
			await sleep(60)
			expect(snapshots, 'a closed stream stops polling').toBe(1)
			// The stream ends with the one snapshot; the late fingerprint went nowhere.
			const rest = await readUntil(reader, () => false)
			expect(rest).toBe('data: []\n\n')
			expect(unhandled).toEqual([])
		} finally {
			abort.abort()
			await reader.cancel().catch(() => undefined)
			process.off('unhandledRejection', onUnhandled)
		}
	})
})
