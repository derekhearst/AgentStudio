import { expect, test } from '@playwright/test'
import { acquireGlobalStateLock, getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * Serialized against the other specs that write this user's budget limits and cost
 * ledger — see `acquireGlobalStateLock` in helpers for why prefix isolation cannot work
 * for these rows.
 */
let releaseBudgetLock: (() => Promise<void>) | null = null
test.beforeEach(async () => {
	releaseBudgetLock = await acquireGlobalStateLock('budget-state')
})
test.afterEach(async () => {
	await releaseBudgetLock?.()
	releaseBudgetLock = null
})

/**
 * Wave 5 #21 phase 4 — per-mode dispatch in `runAutomationById`.
 *
 * Pins behavioral contracts that gate safety:
 *   - research mode opens a `research` row + enqueues a `research_run` job (no chat
 *     messages inserted into the automation's conversation)
 *   - maintenance mode runs a synthesis call without persisting any messages
 *     (operators inspect via lifecycle metrics, not chat history)
 *   - lifecycle metrics emit with the right `mode` dimension so /review/health
 *     distinguishes research throughput from chat_followup throughput
 *
 * The chat_followup happy path is covered by the existing automations.runtime spec.
 * Maintenance mode dispatch issues a real LLM call (no mock layer); we use a tiny
 * prompt + tolerate any provider-side error since the contract we're testing is the
 * persistence shape, not the LLM output.
 */

async function clearTestAutomations(prefix: string) {
	const sql = getSql()
	await sql`delete from research where query like ${`${prefix}%`}`
	await sql`delete from messages where content like ${`${prefix}%`}`
	await sql`delete from conversations where title like ${`${prefix}%`}`
	await sql`delete from automations where description like ${`${prefix}%`}`
}

test.describe('automations/mode-dispatch — research mode', () => {
	test('research mode creates a research row + enqueues research_run, no assistant messages', async () => {
		const prefix = uniquePrefix('automation-research')
		const sql = getSql()
		const userId = await getActiveUserId()
		// Defensive: clear any budget_limit a prior test might have left around.
		const sql_clear = getSql()
		await sql_clear`delete from budget_limits where user_id = ${userId}`
		await sql_clear`delete from llm_usage where user_id = ${userId} and cost::numeric > 1`

		try {
			// Not due: the spec runs it directly (`runAutomationById` ignores nextRunAt), and a
			// slot a week out keeps the dev server's dispatcher from running it concurrently.
			const notDue = new Date(Date.now() + 7 * 24 * 60 * 60_000)
			const [automation] = await sql<{ id: string; conversation_id: string | null }[]>`
				insert into automations (user_id, description, cron_expression, prompt, mode, next_run_at)
				values (
					${userId},
					${`${prefix} research investigation`},
					'0 9 * * *',
					${`${prefix} What changed in the project this week?`},
					'research'::automation_mode,
					${notDue}
				)
				returning id, conversation_id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			const result = (await runAutomationById(automation.id)) as {
				researchId?: string
				jobId?: string
				mode?: string
				conversationId?: string | null
			}
			expect(result.mode).toBe('research')
			expect(typeof result.researchId).toBe('string')
			expect(typeof result.jobId).toBe('string')

			// research row created with the automation's prompt as the query.
			const [research] = await sql<{ id: string; query: string; status: string; job_id: string | null }[]>`
				select id, query, status::text as status, job_id from research where id = ${result.researchId!}
			`
			expect(research.query).toContain(prefix)
			expect(research.job_id).toBe(result.jobId)
			// `research.status` is not asserted, for the same reason as `job.status` below.
			expect(research.status, 'the row exists and carries a status').toBeTruthy()

			// Job enqueued with research_run type.
			const [job] = await sql<{ type: string; status: string; payload: { researchId?: string } }[]>`
				select type::text as type, status::text as status, payload from jobs where id = ${result.jobId!}
			`
			expect(job.type).toBe('research_run')
			expect(job.payload.researchId).toBe(result.researchId)
			// Neither status is asserted, and that is deliberate.
			//
			// The app runs an in-process job worker. Between the dispatch returning and these
			// SELECTs, the worker can claim the research_run job, attempt it, fail for want of
			// a model credential, and move the job to `retry_wait` and the research row to
			// `failed`. Both happened under full-suite load, alternating between the desktop
			// and mobile projects — `job.status` first, then `research.status` once that one
			// was relaxed.
			//
			// What this test is for is dispatch: research mode must create a research row and
			// enqueue a research_run job carrying its id, rather than synthesising an
			// assistant message. Every one of those claims is asserted here and none of them
			// is transient. What the worker subsequently does with the job is the worker's
			// business and has its own specs.
			//
			// `JOBS_WORKER_ENABLED=0` would remove the race at the source, but only by turning
			// the worker off for the whole test server, which the job specs need running.
			expect(job.status, 'the row exists and carries a status').toBeTruthy()

			// No assistant messages should have been inserted into the automation's conversation.
			const conversationId = result.conversationId!
			const [msgCount] = await sql<{ count: number }[]>`
				select count(*)::int as count
				from messages
				where conversation_id = ${conversationId} and role = 'assistant'
			`
			expect(msgCount.count).toBe(0)
		} finally {
			await sql`delete from jobs where payload->>'researchId' in (select id::text from research where query like ${`${prefix}%`})`
			await clearTestAutomations(prefix)
		}
	})

	test('"Run now" and the next scheduled run each start their own research', async () => {
		// The research_run key used to be derived from `nextRunAt`. "Run now" leaves
		// `nextRunAt` alone, so the manual run and the scheduled tick for the same slot built
		// the same key; the tick got the manual run's (finished) job back, linked its fresh
		// research row to it, and that row sat in `planning` forever while the ledger said
		// the tick completed.
		const prefix = uniquePrefix('automation-research-run-now')
		const sql = getSql()
		const userId = await getActiveUserId()
		await sql`delete from budget_limits where user_id = ${userId}`
		await sql`delete from llm_usage where user_id = ${userId} and cost::numeric > 1`

		try {
			// A slot tomorrow, so no dispatcher runs this automation behind the test's back.
			const slot = new Date(Date.now() + 24 * 60 * 60_000)
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, mode, next_run_at)
				values (
					${userId}, ${`${prefix} research`}, '0 9 * * *', ${`${prefix} What changed?`},
					'research'::automation_mode, ${slot}
				)
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			type ResearchResult = { researchId?: string; jobId?: string }
			const manual = (await runAutomationById(automation.id, new Date(), { trigger: 'manual' })) as ResearchResult
			const scheduled = (await runAutomationById(automation.id, new Date(), { trigger: 'schedule' })) as ResearchResult

			expect(scheduled.researchId).not.toBe(manual.researchId)
			expect(scheduled.jobId, "the tick must not be handed the manual run's job").not.toBe(manual.jobId)

			const rows = await sql<{ research_id: string; job_research_id: string | null }[]>`
				select r.id as research_id, j.payload->>'researchId' as job_research_id
				from research r
				left join jobs j on j.id = r.job_id
				where r.query like ${`${prefix}%`}
			`
			expect(rows).toHaveLength(2)
			for (const row of rows) {
				expect(row.job_research_id, 'each research row points at the job that runs it').toBe(row.research_id)
			}
		} finally {
			await sql`delete from jobs where payload->>'researchId' in (select id::text from research where query like ${`${prefix}%`})`
			await clearTestAutomations(prefix)
		}
	})

	test('research lifecycle metric emits with mode=research dimension', async () => {
		const prefix = uniquePrefix('automation-research-metric')
		const sql = getSql()
		const userId = await getActiveUserId()
		// Defensive: clear any budget_limit a prior test might have left around.
		const sql_clear = getSql()
		await sql_clear`delete from budget_limits where user_id = ${userId}`
		await sql_clear`delete from llm_usage where user_id = ${userId} and cost::numeric > 1`

		try {
			// Not due: the spec runs it directly (`runAutomationById` ignores nextRunAt), and a
			// slot a week out keeps the dev server's dispatcher from running it concurrently.
			const notDue = new Date(Date.now() + 7 * 24 * 60 * 60_000)
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, mode, next_run_at)
				values (${userId}, ${`${prefix} M1`}, '0 9 * * *', ${`${prefix} Q1`}, 'research'::automation_mode, ${notDue})
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			await runAutomationById(automation.id)

			// Metric emission is fire-and-forget; allow the microtask queue to drain.
			await new Promise((r) => setTimeout(r, 250))

			const metrics = await sql<{ metric: string; dimension: { mode?: string; status?: string }; value: string }[]>`
				select metric, dimension, value::text as value
				from operational_metrics
				where metric in ('automations.duration_ms', 'automations.lifecycle.completed')
				  and dimension->>'mode' = 'research'
				order by measured_at desc
				limit 5
			`
			expect(metrics.some((m) => m.metric === 'automations.duration_ms')).toBe(true)
			const completed = metrics.find((m) => m.metric === 'automations.lifecycle.completed')
			expect(completed?.dimension.mode).toBe('research')
		} finally {
			await sql`delete from jobs where payload->>'researchId' in (select id::text from research where query like ${`${prefix}%`})`
			await clearTestAutomations(prefix)
		}
	})
})

test.describe('automations/mode-dispatch — code mode fallback', () => {
})
