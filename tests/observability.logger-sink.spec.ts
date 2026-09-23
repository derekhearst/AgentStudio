import { expect, test } from '@playwright/test'
import { uniquePrefix } from './helpers'

/**
 * One failed log flush no longer turns database logging off for the rest of the process.
 *
 * The logger set its DB sink to disabled on any flush failure, and only bootstrap ever
 * turned it back on. A Postgres restart therefore left `app_logs` — and the /review Logs
 * panel — silent until the app restarted. The sink now pauses, retries, keeps what was logged
 * meanwhile (up to a cap) and records how many entries never made it.
 *
 * These run against the logger module in the test process with a fake sink, so nothing is
 * written to the database. Other modules loaded in the same worker may log while they run,
 * so each assertion is about this spec's own entries, or is worked out from what the sink
 * actually received.
 */

type Entry = { message: string; level: string; context: Record<string, unknown> | null }

async function loadLogger() {
	return import('../src/lib/observability/logger')
}

async function until(predicate: () => boolean, timeoutMs = 8_000) {
	const started = Date.now()
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the log sink')
		await new Promise((r) => setTimeout(r, 25))
	}
}

test.describe.configure({ mode: 'serial' })

test.describe('observability/logger — a failed flush pauses the DB sink, it does not disable it', () => {
	test.afterEach(async () => {
		const { configureDbSinkRetry, logger, registerDbSink } = await loadLogger()
		registerDbSink(null)
		configureDbSinkRetry(null)
		logger.setDbSinkEnabled(true)
	})

	test('after a failure the sink waits, then saves what was logged meanwhile and says what was lost', async () => {
		const tag = uniquePrefix('logger-sink-retry')
		const { configureDbSinkRetry, logger, registerDbSink } = await loadLogger()
		configureDbSinkRetry({ baseMs: 300, maxMs: 1_000 })
		let failing = true
		const calls: Entry[][] = []
		registerDbSink(async (batch) => {
			calls.push(batch.map((e) => ({ message: e.message, level: e.level, context: e.context })))
			if (failing) throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
		})

		logger.error(`${tag} before the outage`)
		await until(() => calls.length === 1)
		expect(calls[0].map((e) => e.message)).toContain(`${tag} before the outage`)

		// The database is back, but the sink is still waiting out its pause.
		failing = false
		logger.error(`${tag} during the pause`)
		await new Promise((r) => setTimeout(r, 100))
		expect(calls).toHaveLength(1)

		await until(() => calls.length === 2)
		const saved = calls[1]
		expect(saved.map((e) => e.message)).toContain(`${tag} during the pause`)
		const notice = saved.find((e) => e.context?.unsaved !== undefined)
		expect(notice?.level).toBe('warn')
		// The batch that failed went to the console only, and the notice says how much that was.
		expect(notice?.context?.unsaved).toBe(calls[0].length)

		// And it stays on: the next error is saved at once, with no further notice.
		logger.error(`${tag} after recovery`)
		await until(() => calls.some((batch) => batch.some((e) => e.message === `${tag} after recovery`)))
		const after = calls.find((batch) => batch.some((e) => e.message === `${tag} after recovery`))!
		expect(after.some((e) => e.context?.unsaved !== undefined)).toBe(false)
	})

	test('while paused, the oldest entries past the cap are dropped and counted', async () => {
		const tag = uniquePrefix('logger-sink-cap')
		const { configureDbSinkRetry, logger, registerDbSink } = await loadLogger()
		configureDbSinkRetry({ baseMs: 60_000, bufferMax: 3 })
		let failing = true
		const calls: Entry[][] = []
		registerDbSink(async (batch) => {
			calls.push(batch.map((e) => ({ message: e.message, level: e.level, context: e.context })))
			if (failing) throw new Error('the database system is starting up')
		})

		logger.error(`${tag} 0`)
		await until(() => calls.length === 1)

		// Logged and flushed in one synchronous run, so nothing else can land in between.
		for (let i = 1; i <= 5; i++) logger.warn(`${tag} ${i}`)
		failing = false
		// A shutdown flush does not wait out the pause.
		await logger.flush()

		expect(calls).toHaveLength(2)
		const saved = calls[1]
		// The newest three kept, the two before them pushed out by the cap.
		expect(saved.map((e) => e.message).filter((m) => m.startsWith(tag))).toEqual([`${tag} 3`, `${tag} 4`, `${tag} 5`])
		// At least the failed batch and the two the cap pushed out (more if something else was
		// logged during the pause and pushed out with them).
		const unsaved = saved.find((e) => e.context?.unsaved !== undefined)?.context?.unsaved
		expect(unsaved).toBeGreaterThanOrEqual(calls[0].length + 2)
	})
})
