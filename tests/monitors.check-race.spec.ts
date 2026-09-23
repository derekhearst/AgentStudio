import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'
import type { MonitorCheckDeps } from '../src/lib/monitors/run.server'

/**
 * A monitor check that finishes after the monitor changed under it records nothing and
 * fires nothing.
 *
 * `runMonitorCheck` reads the monitor, then spends seconds observing (a fetch, maybe a model
 * call), then writes the outcome. The write used to be keyed on the id alone and carried a
 * status computed from the stale read, so a Cancel pressed mid-check was silently reverted
 * to `active` — the monitor reappeared and kept spending — and on a firing edge the action
 * still ran for a monitor the user had canceled. "Check now" does not go through the
 * dispatcher's claim either, so it could overlap a scheduled check and both could fire.
 *
 * The real evaluator and actions are swapped for stubs through `runMonitorCheck`'s deps, so
 * the interleaving is exact and nothing leaves the process.
 */

type Row = {
	status: string
	check_count: number
	fire_count: number
	condition_met: boolean
	consecutive_errors: number
	last_observation: unknown
}

async function createSpecMonitor(prefix: string) {
	const { createMonitor } = await import('../src/lib/monitors/monitors.server')
	const monitor = await createMonitor({
		userId: await getActiveUserId(),
		name: `${prefix} back in stock`,
		condition: {
			kind: 'tool_result',
			tool: 'web_fetch',
			args: { url: 'https://example.com/product' },
			extract: 'text',
			compare: 'contains',
			value: 'in stock',
		},
		action: 'review_item',
	})
	// Not due, so the running app's own dispatcher never checks it behind the spec's back.
	await getSql()`update monitors set next_check_at = now() + interval '1 day' where id = ${monitor.id}`
	return monitor
}

async function readRow(id: string): Promise<Row> {
	const [row] = await getSql()<Row[]>`
		select status::text as status, check_count, fire_count, condition_met, consecutive_errors, last_observation
		from monitors where id = ${id}
	`
	return row
}

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from review_items where payload->>'monitorId' in (select id::text from monitors where name like ${`${prefix}%`})`
	await sql`delete from monitors where name like ${`${prefix}%`}`
}

async function metObservation() {
	const { buildObservation } = await import('../src/lib/monitors/condition')
	return buildObservation('Now in stock', true)
}

function recordingDispatch(dispatched: string[]): NonNullable<MonitorCheckDeps['dispatch']> {
	return async (monitor) => {
		dispatched.push(monitor.id)
		return { kind: monitor.action, ok: true, detail: {} }
	}
}

test.describe('monitors/check-race — the monitor changes while a check is running', () => {
	test('a cancel that lands mid-check wins, and the action never runs', async () => {
		const prefix = uniquePrefix('monitor-cancel-mid-check')
		try {
			const userId = await getActiveUserId()
			const monitor = await createSpecMonitor(prefix)
			const { runMonitorCheck } = await import('../src/lib/monitors/run.server')
			const { cancelMonitor } = await import('../src/lib/monitors/monitors.server')
			const observation = await metObservation()
			const dispatched: string[] = []

			const result = await runMonitorCheck(monitor.id, new Date(), {
				evaluate: async (m) => {
					await cancelMonitor(userId, m.id)
					return { outcome: 'observed', met: true, observation }
				},
				dispatch: recordingDispatch(dispatched),
			})

			expect(result.outcome).toBe('skipped')
			expect(result.status).toBe('canceled')
			expect(dispatched, 'no action for a canceled monitor').toEqual([])

			const row = await readRow(monitor.id)
			expect(row.status, 'the cancel is not reverted').toBe('canceled')
			expect(row.check_count).toBe(0)
			expect(row.fire_count).toBe(0)
			expect(row.condition_met).toBe(false)
			expect(row.last_observation).toBeNull()
		} finally {
			await cleanup(prefix)
		}
	})

	test('a pause during a failing check is not overwritten by `failed`, and opens no review item', async () => {
		const prefix = uniquePrefix('monitor-pause-mid-error')
		const sql = getSql()
		try {
			const userId = await getActiveUserId()
			const monitor = await createSpecMonitor(prefix)
			// One more error would retire it as `failed` and open a review item.
			await sql`update monitors set consecutive_errors = 4 where id = ${monitor.id}`
			const { runMonitorCheck } = await import('../src/lib/monitors/run.server')
			const { setMonitorPaused } = await import('../src/lib/monitors/monitors.server')

			const result = await runMonitorCheck(monitor.id, new Date(), {
				evaluate: async (m) => {
					await setMonitorPaused(userId, m.id, true)
					return { outcome: 'error', message: 'web_fetch failed: 503' }
				},
				dispatch: recordingDispatch([]),
			})

			expect(result.outcome).toBe('skipped')
			const row = await readRow(monitor.id)
			expect(row.status).toBe('paused')
			expect(row.consecutive_errors, 'the discarded check is not counted').toBe(4)
			expect(row.check_count).toBe(0)

			const items = await sql`select id from review_items where payload->>'monitorId' = ${monitor.id}`
			expect(items).toHaveLength(0)
		} finally {
			await cleanup(prefix)
		}
	})

	test('two overlapping checks of one monitor commit once and fire once', async () => {
		// "Check now" alongside a scheduled check: both saw the condition go true.
		const prefix = uniquePrefix('monitor-overlapping-checks')
		try {
			const monitor = await createSpecMonitor(prefix)
			const { runMonitorCheck } = await import('../src/lib/monitors/run.server')
			const observation = await metObservation()
			const dispatched: string[] = []
			const plainCheck: MonitorCheckDeps = {
				evaluate: async () => ({ outcome: 'observed', met: true, observation }),
				dispatch: recordingDispatch(dispatched),
			}

			const seen: { inner?: Awaited<ReturnType<typeof runMonitorCheck>> } = {}
			const outer = await runMonitorCheck(monitor.id, new Date(), {
				// The second check starts and finishes while the first is still observing.
				evaluate: async (m) => {
					seen.inner = await runMonitorCheck(m.id, new Date(), plainCheck)
					return { outcome: 'observed', met: true, observation }
				},
				dispatch: recordingDispatch(dispatched),
			})

			expect(seen.inner?.outcome).toBe('fired')
			expect(outer.outcome, 'the slower check finds the monitor already moved on').toBe('skipped')
			expect(dispatched).toEqual([monitor.id])

			const row = await readRow(monitor.id)
			expect(row.check_count).toBe(1)
			expect(row.fire_count).toBe(1)
			expect(row.status, 'one-shot by default').toBe('fired')
		} finally {
			await cleanup(prefix)
		}
	})

	test('an undisturbed check still records its observation and fires', async () => {
		const prefix = uniquePrefix('monitor-undisturbed-check')
		try {
			const monitor = await createSpecMonitor(prefix)
			const { runMonitorCheck } = await import('../src/lib/monitors/run.server')
			const observation = await metObservation()
			const dispatched: string[] = []

			const result = await runMonitorCheck(monitor.id, new Date(), {
				evaluate: async () => ({ outcome: 'observed', met: true, observation }),
				dispatch: recordingDispatch(dispatched),
			})

			expect(result.outcome).toBe('fired')
			expect(dispatched).toEqual([monitor.id])
			const row = await readRow(monitor.id)
			expect(row.status).toBe('fired')
			expect(row.check_count).toBe(1)
			expect(row.condition_met).toBe(true)
		} finally {
			await cleanup(prefix)
		}
	})
})
