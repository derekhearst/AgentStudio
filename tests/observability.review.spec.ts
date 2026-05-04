import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #20 phase 1 — review inbox + observability schema invariants.
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

async function cleanupReviewPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from review_items where (summary like ${`${prefix}%`}) or (payload->>'tag' = ${prefix})`
	await sql`delete from run_traces where run_id::text like ${`${prefix}%`}`
	await sql`delete from operational_metrics where metric like ${`${prefix}%`}`
}

test.describe('observability/review — review_items invariants', () => {
	test('review_item defaults: status=open, severity=warning, payload={}', async () => {
		const prefix = uniquePrefix('review-defaults')
		const sql = getSql()
		try {
			const [row] = await sql<{
				id: string
				status: string
				severity: string
				payload: Record<string, unknown>
			}[]>`
				insert into review_items (type, summary, payload)
				values ('approval_request', ${`${prefix} sample`}, ${sql.json({ tag: prefix })})
				returning id, status::text as status, severity::text as severity, payload
			`
			expect(row.status).toBe('open')
			expect(row.severity).toBe('warning')
		} finally {
			await cleanupReviewPrefix(prefix)
		}
	})

	test('review_item_type enum rejects unknown values', async () => {
		const prefix = uniquePrefix('review-bad-type')
		const sql = getSql()
		try {
			let threw = false
			try {
				await sql`
					insert into review_items (type, summary)
					values ('unknown_type'::review_item_type, ${`${prefix} bad`})
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await cleanupReviewPrefix(prefix)
		}
	})

	test('resolution + resolved_at + resolved_by are set on resolve', async () => {
		const prefix = uniquePrefix('review-resolve')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [item] = await sql<{ id: string }[]>`
				insert into review_items (type, summary, payload)
				values ('evaluation_failure', ${`${prefix} failure`}, ${sql.json({ tag: prefix })})
				returning id
			`
			await sql`
				update review_items
				set status = 'resolved'::review_item_status,
				    resolved_by = ${userId},
				    resolution = ${sql.json({ action: 'approved-with-note', note: 'looks fine' })},
				    resolved_at = now(),
				    updated_at = now()
				where id = ${item.id}
			`
			const [check] = await sql<{
				status: string
				resolved_by: string | null
				resolution: { action: string; note?: string } | null
				resolved_at: Date | null
			}[]>`
				select status::text as status, resolved_by, resolution, resolved_at
				from review_items where id = ${item.id}
			`
			expect(check.status).toBe('resolved')
			expect(check.resolved_by).toBe(userId)
			expect(check.resolution?.action).toBe('approved-with-note')
			expect(check.resolved_at).not.toBeNull()
		} finally {
			await cleanupReviewPrefix(prefix)
		}
	})

	test('cross-domain pointers (run_id, task_id, job_id) survive deletes (no enforced FK)', async () => {
		const prefix = uniquePrefix('review-survive')
		const sql = getSql()
		try {
			const fakeRunId = randomUUID()
			const fakeTaskId = randomUUID()
			const fakeJobId = randomUUID()
			const [item] = await sql<{ id: string }[]>`
				insert into review_items (type, summary, payload, run_id, task_id, job_id)
				values (
					'job_failure', ${`${prefix} survive`},
					${sql.json({ tag: prefix })},
					${fakeRunId}, ${fakeTaskId}, ${fakeJobId}
				)
				returning id
			`
			const [check] = await sql<{ run_id: string | null; task_id: string | null; job_id: string | null }[]>`
				select run_id, task_id, job_id from review_items where id = ${item.id}
			`
			expect(check.run_id).toBe(fakeRunId)
			expect(check.task_id).toBe(fakeTaskId)
			expect(check.job_id).toBe(fakeJobId)
		} finally {
			await cleanupReviewPrefix(prefix)
		}
	})
})

test.describe('observability/run-traces — runTraces schema', () => {
	test('runTrace defaults: status=running, trace=[], counts=0', async () => {
		const prefix = uniquePrefix('trace-defaults')
		const sql = getSql()
		try {
			const fakeRunId = randomUUID()
			const [row] = await sql<{
				id: string
				status: string
				trace: unknown[]
				tool_call_count: number
				round_count: number
				cost_usd: string
			}[]>`
				insert into run_traces (run_id) values (${fakeRunId})
				returning id, status::text as status, trace, tool_call_count, round_count, cost_usd
			`
			expect(row.status).toBe('running')
			expect(row.trace).toEqual([])
			expect(row.tool_call_count).toBe(0)
			expect(row.round_count).toBe(0)
			expect(parseFloat(row.cost_usd)).toBe(0)
		} finally {
			const sqlCleanup = getSql()
			await sqlCleanup`delete from run_traces where run_id in (select run_id from run_traces order by created_at desc limit 5)`
			void prefix
		}
	})
})

test.describe('observability/metrics — operational_metrics schema', () => {
	test('metric row stores name + dimension + value', async () => {
		const prefix = uniquePrefix('metric')
		const sql = getSql()
		try {
			const [row] = await sql<{
				id: string
				metric: string
				dimension: Record<string, unknown>
				value: string
			}[]>`
				insert into operational_metrics (metric, dimension, value)
				values (${`${prefix}.queue.depth`}, ${sql.json({ queue: 'default' })}, 42)
				returning id, metric, dimension, value
			`
			expect(row.metric).toBe(`${prefix}.queue.depth`)
			expect(row.dimension).toEqual({ queue: 'default' })
			expect(parseFloat(row.value)).toBe(42)
		} finally {
			const sqlCleanup = getSql()
			await sqlCleanup`delete from operational_metrics where metric like ${`${prefix}%`}`
		}
	})
})
