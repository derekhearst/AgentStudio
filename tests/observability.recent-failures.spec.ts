import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { authenticateContext, getActiveUserId, getSql, pollDb, uniquePrefix } from './helpers'

/**
 * /review's "Recent failures" lists the runs that failed.
 *
 * It read run-level failures from `run_traces`, which the engine's chat path never writes
 * and whose only writer always recorded `completed`. A failed chat turn therefore showed in
 * the KPI strip's failed-run count while the panel beside it said "No failures in the last
 * 24h". Failed runs now come from `chat_runs`, where every run path records how it ended.
 */

type RunState = 'completed' | 'failed' | 'canceled'

async function seedRun(prefix: string, state: RunState, opts: { error?: string; finishedHoursAgo?: number } = {}) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [conv] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, 'claude-sonnet-5', 0, '0')
		returning id
	`
	const hoursAgo = opts.finishedHoursAgo ?? 0
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, state, label, error, finished_at)
		values (
			${conv.id}, ${userId}, ${state}::chat_run_state, ${state === 'failed' ? 'Failed' : state},
			${opts.error ?? null}, now() - (${hoursAgo}::int * interval '1 hour')
		)
		returning id
	`
	return run.id
}

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`
		delete from llm_usage where run_id in (
			select r.id from chat_runs r join conversations c on c.id = r.conversation_id
			where c.title like ${`${prefix}%`}
		)
	`
	await sql`delete from conversations where title like ${`${prefix}%`}`
}

test.describe('observability/recent-failures — failed runs are listed', () => {
	test('a failed chat run is listed with its error and its ledger cost; other endings and old runs are not', async () => {
		const prefix = uniquePrefix('recent-failures')
		const sql = getSql()
		try {
			const failed = await seedRun(prefix, 'failed', {
				error: `${prefix} 400 invalid model: claude-sonnet-5\n    at chat (chat.server.ts:10)`,
			})
			const completed = await seedRun(prefix, 'completed')
			const canceled = await seedRun(prefix, 'canceled', { error: 'Stopped by user' })
			const old = await seedRun(prefix, 'failed', { error: `${prefix} old failure`, finishedHoursAgo: 30 })
			await sql`
				insert into llm_usage (source, model, tokens_in, tokens_out, cost, run_id)
				values ('chat', 'anthropic/claude-sonnet-5', 10, 5, '0.000125', ${failed})
			`

			const { listRecentFailures } = await import('../src/lib/observability/traces.server')
			const failures = await listRecentFailures(24, 50)
			const mine = failures.filter((f) => [failed, completed, canceled, old].includes(f.runId))

			expect(mine).toHaveLength(1)
			expect(mine[0].runId).toBe(failed)
			expect(mine[0].kind).toBe('run_failed')
			// The error's first line, not its stack.
			expect(mine[0].label).toBe(`${prefix} 400 invalid model: claude-sonnet-5`)
			expect(Number(mine[0].costUsd)).toBeCloseTo(0.000125, 9)
		} finally {
			await cleanup(prefix)
		}
	})

	test('the /review panel shows the failed run and links to its run page', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('recent-failures-ui')
		await authenticateContext(page.context())
		try {
			const failed = await seedRun(prefix, 'failed', { error: `${prefix} provider returned 500` })

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto('/review', { waitUntil: 'domcontentloaded' })
			const row = page.getByTestId('recent-failure').filter({ hasText: `${prefix} provider returned 500` })
			await expect(row).toBeVisible({ timeout: 30_000 })
			await expect(row).toHaveAttribute('href', `/runs/${failed}`)
		} finally {
			await cleanup(prefix)
		}
	})
})

test.describe('observability/recent-failures — traces end the way the run did', () => {
	test('closeRunTrace records a failed run as failed', async () => {
		const sql = getSql()
		const runId = randomUUID()
		try {
			await sql`insert into run_traces (run_id, trace) values (${runId}, '[]'::jsonb)`
			const { closeRunTrace } = await import('../src/lib/runtime/trace-helpers')
			closeRunTrace(runId, 'failed')

			const [row] = await pollDb(
				() => sql<{ status: string; finished_at: Date | null }[]>`
					select status::text as status, finished_at from run_traces where run_id = ${runId}
				`,
				(rows) => rows[0]?.status !== 'running',
				{ description: 'trace closed' },
			)
			expect(row.status).toBe('failed')
			expect(row.finished_at).not.toBeNull()
		} finally {
			await sql`delete from run_traces where run_id = ${runId}`
		}
	})
})
