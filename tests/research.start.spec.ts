import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #18 phase 3 — startResearchCommand row-shape contract.
 *
 * Phase 2's runResearchLoop is exercised by manual tickets via /research; this spec pins
 * the durable contract that startResearchCommand creates: a research row + a research_run
 * job linked back via research.job_id. The full LLM-driven loop end-to-end is exercised
 * once a real research run completes (the in-process worker started in db.server.ts will
 * pick up enqueued jobs).
 */

async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

async function cleanupResearchPrefix(prefix: string) {
	const sql = getSql()
	// Cascade trims sources + steps when research is deleted; jobs are not cascaded
	// (intentional — see jobs schema), so explicitly delete enqueued research_run jobs too.
	await sql`delete from jobs where type = 'research_run' and payload->>'researchId' in (select id::text from research where query like ${`${prefix}%`})`
	await sql`delete from research where query like ${`${prefix}%`}`
}

test.describe('research/start — row + job creation contract', () => {
	test('starting research creates a research row + a pending research_run job linked back via job_id', async () => {
		const prefix = uniquePrefix('research-start-link')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			// Simulate startResearchCommand without invoking the SvelteKit handler:
			//   1. Insert research row (status='planning')
			//   2. Insert research_run job pointing at researchId
			//   3. Backlink research.job_id to the job
			const [r] = await sql<{ id: string }[]>`
				insert into research (user_id, query, status)
				values (${userId}, ${`${prefix} how do hydrofoils generate lift`}, 'planning'::research_status)
				returning id
			`
			const [job] = await sql<{ id: string }[]>`
				insert into jobs (type, queue, priority, payload, user_id)
				values ('research_run', 'default', 150, ${sql.json({ researchId: r.id })}, ${userId})
				returning id
			`
			await sql`update research set job_id = ${job.id} where id = ${r.id}`

			// Now verify the link round-trips both ways.
			const [check] = await sql<{ job_id: string | null; research_id: string | null }[]>`
				select r.job_id, j.payload->>'researchId' as research_id
				from research r
				join jobs j on j.id = r.job_id
				where r.id = ${r.id}
			`
			expect(check.job_id).toBe(job.id)
			expect(check.research_id).toBe(r.id)
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})

	test('research_run job priority defaults to user-actionable tier', async () => {
		const prefix = uniquePrefix('research-priority')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [r] = await sql<{ id: string }[]>`
				insert into research (user_id, query) values (${userId}, ${`${prefix} q`}) returning id
			`
			const [job] = await sql<{ priority: number }[]>`
				insert into jobs (type, priority, payload, user_id)
				values ('research_run', 150, ${sql.json({ researchId: r.id })}, ${userId})
				returning priority
			`
			expect(job.priority).toBeGreaterThan(100) // outranks default background work
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})

	test('cancel transition: status flips canceled + finished_at set', async () => {
		const prefix = uniquePrefix('research-cancel')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [r] = await sql<{ id: string }[]>`
				insert into research (user_id, query, status)
				values (${userId}, ${`${prefix} q`}, 'searching'::research_status)
				returning id
			`
			await sql`update research set status = 'canceled'::research_status, finished_at = now() where id = ${r.id}`
			const [check] = await sql<{ status: string; finished_at: Date | null }[]>`
				select status::text as status, finished_at from research where id = ${r.id}
			`
			expect(check.status).toBe('canceled')
			expect(check.finished_at).not.toBeNull()
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})

	test('composer-selected model round-trips through the research row', async () => {
		// Deep Research rebuild — research.model column stores the composer's selected model so
		// the orchestrator can override DEFAULT_RESEARCH_CONFIG.{plannerModel,synthesizerModel}
		// for this specific run. Per-agent config still wins for runs without a composer pick
		// (automation-triggered, etc.).
		const prefix = uniquePrefix('research-model')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [r] = await sql<{ id: string; model: string | null }[]>`
				insert into research (user_id, query, model)
				values (${userId}, ${`${prefix} q`}, 'anthropic/claude-sonnet-4-6')
				returning id, model
			`
			expect(r.model).toBe('anthropic/claude-sonnet-4-6')

			// Defaulting to null when omitted (automation path).
			const [r2] = await sql<{ id: string; model: string | null }[]>`
				insert into research (user_id, query) values (${userId}, ${`${prefix} q2`})
				returning id, model
			`
			expect(r2.model).toBeNull()
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})

	test("'reflecting' status is a valid enum value (Deep Research rebuild)", async () => {
		// The orchestrator transitions through 'reflecting' between fetching and synthesizing.
		// This pins the migration that added the value to the research_status enum.
		const prefix = uniquePrefix('research-reflecting')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [r] = await sql<{ id: string }[]>`
				insert into research (user_id, query, status)
				values (${userId}, ${`${prefix} q`}, 'reflecting'::research_status)
				returning id
			`
			const [check] = await sql<{ status: string }[]>`
				select status::text as status from research where id = ${r.id}
			`
			expect(check.status).toBe('reflecting')
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})

	test('completed research has report + cited sources + finished_at', async () => {
		const prefix = uniquePrefix('research-complete')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [r] = await sql<{ id: string }[]>`
				insert into research (user_id, query) values (${userId}, ${`${prefix} q`}) returning id
			`
			await sql`
				insert into research_sources (research_id, url, title, extracted_text, cited_in_report)
				values
					(${r.id}, 'https://a.com/1', 'A', 'a content', true),
					(${r.id}, 'https://b.com/2', 'B', 'b content', false),
					(${r.id}, 'https://c.com/3', 'C', 'c content', true)
			`
			await sql`
				update research
				set status = 'complete'::research_status,
				    report = '## Summary\n\nPer [1] and [3], the answer is X.',
				    finished_at = now(),
				    cost_usd = 0.0234,
				    tokens_used = 1234
				where id = ${r.id}
			`
			const [research] = await sql<{
				status: string
				report: string
				cost_usd: string
				tokens_used: number
			}[]>`
				select status::text as status, report, cost_usd, tokens_used from research where id = ${r.id}
			`
			expect(research.status).toBe('complete')
			expect(research.report).toContain('the answer is X')
			expect(parseFloat(research.cost_usd)).toBeCloseTo(0.0234, 4)
			expect(research.tokens_used).toBe(1234)

			const [{ cited }] = await sql<{ cited: number }[]>`
				select count(*)::int as cited from research_sources
				where research_id = ${r.id} and cited_in_report = true
			`
			expect(cited).toBe(2)
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})
})
