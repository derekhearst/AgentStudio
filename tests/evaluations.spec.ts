import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * Wave 3 #14 phase 1+2 — evaluation framework schema invariants.
 *
 * Schema-level test of the durable contract: the run_evaluations row shape, verdict enum,
 * findings array, FK cascade behavior, and the chat_runs.eval_required / eval_attempt
 * columns. Phase 3+ live integration (spawning evaluator runs) is exercised once the
 * orchestration lands — for now the recordEvaluation helper is what writes to this table.
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

async function setupRun(prefix: string, userId: string, opts: { evalRequired?: boolean } = {}) {
	const sql = getSql()
	const [conv] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id
	`
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (id, conversation_id, user_id, state, source, label, eval_required)
		values (
			${randomUUID()},
			${conv.id},
			${userId},
			'completed'::chat_run_state,
			'chat_stream',
			${`${prefix} run`},
			${opts.evalRequired ?? false}
		)
		returning id
	`
	return { conversationId: conv.id, runId: run.id }
}

test.describe('evaluations/schema — run_evaluations + chat_runs.eval_*', () => {
	test('inserting a pass verdict with findings round-trips', async () => {
		const prefix = uniquePrefix('eval-pass')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { runId } = await setupRun(prefix, userId)
			const [row] = await sql<{ id: string }[]>`
				insert into run_evaluations (run_id, verdict, findings, confidence, cost_usd, metadata)
				values (
					${runId},
					'pass'::evaluation_verdict,
					${sql.json([
						{ severity: 'info', message: 'looks good' },
						{ severity: 'warning', category: 'style', message: 'consider adding a comment' },
					])},
					0.92,
					'0.0023',
					${sql.json({ evaluator: 'gpt-4o-mini' })}
				)
				returning id
			`
			const [check] = await sql<{
				verdict: string
				findings: Array<{ severity: string; message: string }>
				confidence: number
				cost_usd: string
				metadata: Record<string, unknown>
			}[]>`
				select verdict::text as verdict, findings, confidence, cost_usd, metadata
				from run_evaluations where id = ${row.id}
			`
			expect(check.verdict).toBe('pass')
			expect(check.findings).toHaveLength(2)
			expect(check.findings[1].category).toBe('style')
			expect(check.confidence).toBeCloseTo(0.92, 2)
			expect(parseFloat(check.cost_usd)).toBeCloseTo(0.0023, 4)
			expect(check.metadata.evaluator).toBe('gpt-4o-mini')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('verdict enum rejects unknown values', async () => {
		const prefix = uniquePrefix('eval-enum')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { runId } = await setupRun(prefix, userId)
			let threw = false
			try {
				await sql`
					insert into run_evaluations (run_id, verdict, findings)
					values (${runId}, 'maybe'::evaluation_verdict, ${sql.json([])})
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('FK cascade — deleting the source run trims its evaluations', async () => {
		const prefix = uniquePrefix('eval-cascade')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { runId } = await setupRun(prefix, userId)
			await sql`
				insert into run_evaluations (run_id, verdict, findings)
				values
					(${runId}, 'needs_revision'::evaluation_verdict, ${sql.json([])}),
					(${runId}, 'pass'::evaluation_verdict, ${sql.json([])})
			`
			const [{ before }] = await sql<{ before: number }[]>`
				select count(*)::int as before from run_evaluations where run_id = ${runId}
			`
			expect(before).toBe(2)
			await sql`delete from chat_runs where id = ${runId}`
			const [{ after }] = await sql<{ after: number }[]>`
				select count(*)::int as after from run_evaluations where run_id = ${runId}
			`
			expect(after).toBe(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('eval_required + eval_attempt round-trip on chat_runs (defaults to false / 0)', async () => {
		const prefix = uniquePrefix('eval-runs-cols')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const defaults = await setupRun(prefix, userId)
			const [defaultRun] = await sql<{ eval_required: boolean; eval_attempt: number }[]>`
				select eval_required, eval_attempt from chat_runs where id = ${defaults.runId}
			`
			expect(defaultRun.eval_required).toBe(false)
			expect(defaultRun.eval_attempt).toBe(0)

			const required = await setupRun(prefix, userId, { evalRequired: true })
			await sql`update chat_runs set eval_attempt = 2 where id = ${required.runId}`
			const [check] = await sql<{ eval_required: boolean; eval_attempt: number }[]>`
				select eval_required, eval_attempt from chat_runs where id = ${required.runId}
			`
			expect(check.eval_required).toBe(true)
			expect(check.eval_attempt).toBe(2)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('findings aggregate by severity (pure JS — mirrors summarizeFindingsForRun)', async () => {
		const prefix = uniquePrefix('eval-summary')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { runId } = await setupRun(prefix, userId)
			await sql`
				insert into run_evaluations (run_id, verdict, findings)
				values
					(${runId}, 'needs_revision'::evaluation_verdict, ${sql.json([
						{ severity: 'error', message: 'broke' },
						{ severity: 'warning', message: 'meh' },
					])}),
					(${runId}, 'pass'::evaluation_verdict, ${sql.json([
						{ severity: 'info', message: 'great' },
						{ severity: 'info', message: 'nice' },
					])})
			`
			const rows = await sql<{ findings: Array<{ severity: string }> }[]>`
				select findings from run_evaluations where run_id = ${runId} order by created_at asc
			`
			const counts = { info: 0, warning: 0, error: 0 }
			for (const r of rows) {
				for (const f of r.findings) {
					counts[f.severity as keyof typeof counts]++
				}
			}
			expect(counts).toEqual({ info: 2, warning: 1, error: 1 })
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
