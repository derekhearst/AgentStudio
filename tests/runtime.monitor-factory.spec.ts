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
