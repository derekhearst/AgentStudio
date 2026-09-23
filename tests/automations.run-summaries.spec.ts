import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * Each automation's card status is computed for that automation, whatever its neighbours do.
 *
 * `getLatestRunSummaries` used to read the 500 newest runs across ALL of a user's
 * automations and derive every card's last run and 24h failure count from that slice. An
 * automation on `* * * * *` fills 500 rows in about eight hours, after which every other
 * automation fell out of the slice: the daily job that failed at 09:00 showed no last-run
 * badge and no failure by 18:00, and the header's "failing" chip did not count it.
 */

test.describe('automations/run-summaries — one busy automation cannot hide the others', () => {
	test('a daily automation keeps its failed last run behind 520 newer runs of a per-minute one', async () => {
		const prefix = uniquePrefix('automation-run-summaries')
		const sql = getSql()
		const userId = await getActiveUserId()
		try {
			const [busy] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, enabled)
				values (${userId}, ${`${prefix} every minute`}, '* * * * *', ${`${prefix} ping`}, false)
				returning id
			`
			const [daily] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, enabled)
				values (${userId}, ${`${prefix} daily`}, '0 9 * * *', ${`${prefix} digest`}, false)
				returning id
			`

			// 520 runs of the busy one over the last ~8.7 hours; three of them failed.
			await sql`
				insert into automation_runs (automation_id, user_id, status, started_at, finished_at)
				select ${busy.id}, ${userId},
					case when i % 200 = 100 then 'failed' else 'completed' end,
					now() - (i * interval '1 minute'),
					now() - (i * interval '1 minute') + interval '5 seconds'
				from generate_series(0, 519) as i
			`
			// The daily one failed ten hours ago (older than every busy run), and once more
			// the day before — outside the 24h window.
			await sql`
				insert into automation_runs (automation_id, user_id, status, started_at, error)
				values
					(${daily.id}, ${userId}, 'failed', now() - interval '10 hours', 'upstream timed out'),
					(${daily.id}, ${userId}, 'failed', now() - interval '30 hours', 'upstream timed out')
			`

			const { getLatestRunSummaries } = await import('../src/lib/automations/automation-runs.server')
			const summaries = await getLatestRunSummaries([busy.id, daily.id])

			const dailySummary = summaries.get(daily.id)
			expect(dailySummary, 'the daily card still has a last run').toBeTruthy()
			expect(dailySummary!.status).toBe('failed')
			expect(dailySummary!.error).toBe('upstream timed out')
			expect(dailySummary!.failures24h, 'only the failure inside the last 24 hours counts').toBe(1)

			const busySummary = summaries.get(busy.id)
			expect(busySummary!.status, 'the newest busy run').toBe('completed')
			expect(busySummary!.failures24h).toBe(3)
			expect(Date.now() - busySummary!.startedAt.getTime()).toBeLessThan(5 * 60_000)
		} finally {
			// Runs cascade with their automation.
			await sql`delete from automations where description like ${`${prefix}%`}`
		}
	})

	test('an automation that never ran has no summary, and no ids is no query', async () => {
		const prefix = uniquePrefix('automation-run-summaries-empty')
		const sql = getSql()
		const userId = await getActiveUserId()
		try {
			const [fresh] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, enabled)
				values (${userId}, ${`${prefix} fresh`}, '0 9 * * *', ${`${prefix} digest`}, false)
				returning id
			`
			const { getLatestRunSummaries } = await import('../src/lib/automations/automation-runs.server')
			expect((await getLatestRunSummaries([fresh.id])).has(fresh.id)).toBe(false)
			expect((await getLatestRunSummaries([])).size).toBe(0)
		} finally {
			await sql`delete from automations where description like ${`${prefix}%`}`
		}
	})
})
