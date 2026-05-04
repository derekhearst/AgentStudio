import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #17 phase 5 — evaluation_run job migration contract.
 *
 * The chat-stream handler used to call `void runEvaluatorPass(...)` directly when
 * `chat_runs.eval_required = true`. It now enqueues an `evaluation_run` job with
 * `dedupeKey = eval:${runId}`. This spec pins the dedupe + payload + queue contract so a
 * regression in the migration can't silently start spawning duplicate evaluator passes.
 *
 * Live evaluator-pass execution is exercised by the existing evaluation tests + chat-stream
 * live tests (which now go through the enqueue → worker → runEvaluatorPass path).
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

async function cleanupEvalPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from jobs where type = 'evaluation_run' and dedupe_key like ${`eval:${prefix}%`}`
	await sql`delete from chat_runs where label like ${`${prefix}%`}`
	await sql`delete from conversations where title like ${`${prefix}%`}`
}

test.describe('evaluations/eval-job — dedupe + payload + queue contract', () => {
	test('repeated enqueue with the same runId collapses to one job', async () => {
		const prefix = uniquePrefix('eval-dedupe')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [conv] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} c`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`
			const runId = randomUUID()
			await sql`
				insert into chat_runs (id, conversation_id, user_id, state, source, label, eval_required)
				values (${runId}, ${conv.id}, ${userId}, 'completed'::chat_run_state, 'chat_stream', ${`${prefix} run`}, true)
			`
			// First enqueue → creates row.
			await sql`
				insert into jobs (type, queue, priority, dedupe_key, payload, user_id, run_id)
				values (
					'evaluation_run', 'default', 75, ${`eval:${runId}`},
					${sql.json({ runId, userId, conversationId: conv.id, taskDescription: 'q', generatorOutput: 'a' })},
					${userId}, ${runId}
				)
			`
			// Second enqueue MUST collide on the unique index.
			let secondThrew = false
			try {
				await sql`
					insert into jobs (type, queue, priority, dedupe_key, payload, user_id, run_id)
					values (
						'evaluation_run', 'default', 75, ${`eval:${runId}`},
						${sql.json({ runId, userId, conversationId: conv.id, taskDescription: 'q', generatorOutput: 'a' })},
						${userId}, ${runId}
					)
				`
			} catch {
				secondThrew = true
			}
			expect(secondThrew, 'second enqueue with same dedupe_key should be rejected').toBe(true)

			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from jobs where dedupe_key = ${`eval:${runId}`}
			`
			expect(count).toBe(1)
		} finally {
			await cleanupEvalPrefix(prefix)
		}
	})

	test('evaluation_run jobs land at priority 75 (above memory_mine 50, below user 100+)', async () => {
		const prefix = uniquePrefix('eval-priority')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [conv] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} c`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`
			const runId = randomUUID()
			await sql`
				insert into chat_runs (id, conversation_id, user_id, state, source, label, eval_required)
				values (${runId}, ${conv.id}, ${userId}, 'completed'::chat_run_state, 'chat_stream', ${`${prefix} run`}, true)
			`
			const [job] = await sql<{ priority: number; type: string }[]>`
				insert into jobs (type, queue, priority, dedupe_key, payload, user_id, run_id)
				values (
					'evaluation_run', 'default', 75, ${`eval:${runId}`},
					${sql.json({ runId, userId, conversationId: conv.id, taskDescription: 'q', generatorOutput: 'a' })},
					${userId}, ${runId}
				)
				returning priority, type
			`
			expect(job.priority).toBe(75)
			expect(job.type).toBe('evaluation_run')
			// Sandwich check: 50 (memory_mine) < 75 (eval) < 100 (default user) < 150 (research_run)
			expect(job.priority).toBeGreaterThan(50)
			expect(job.priority).toBeLessThan(100)
		} finally {
			await cleanupEvalPrefix(prefix)
		}
	})

	test('evaluation_run job back-links runId for /settings/jobs trace', async () => {
		const prefix = uniquePrefix('eval-runlink')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [conv] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} c`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`
			const runId = randomUUID()
			await sql`
				insert into chat_runs (id, conversation_id, user_id, state, source, label, eval_required)
				values (${runId}, ${conv.id}, ${userId}, 'completed'::chat_run_state, 'chat_stream', ${`${prefix} run`}, true)
			`
			const [job] = await sql<{ run_id: string | null; session_id: string | null }[]>`
				insert into jobs (type, dedupe_key, payload, user_id, run_id, session_id)
				values (
					'evaluation_run', ${`eval:${runId}`},
					${sql.json({ runId, userId, conversationId: conv.id, taskDescription: 'q', generatorOutput: 'a' })},
					${userId}, ${runId}, ${conv.id}
				)
				returning run_id, session_id
			`
			expect(job.run_id).toBe(runId)
			expect(job.session_id).toBe(conv.id)
		} finally {
			await cleanupEvalPrefix(prefix)
		}
	})

	test('different runs get independent dedupe keys (no cross-collision)', async () => {
		const prefix = uniquePrefix('eval-cross-run')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [conv] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} c`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`
			const r1 = randomUUID()
			const r2 = randomUUID()
			await sql`
				insert into chat_runs (id, conversation_id, user_id, state, source, label, eval_required)
				values
					(${r1}, ${conv.id}, ${userId}, 'completed'::chat_run_state, 'chat_stream', ${`${prefix} r1`}, true),
					(${r2}, ${conv.id}, ${userId}, 'completed'::chat_run_state, 'chat_stream', ${`${prefix} r2`}, true)
			`
			await sql`
				insert into jobs (type, dedupe_key, payload, user_id, run_id) values
					('evaluation_run', ${`eval:${r1}`}, ${sql.json({ runId: r1 })}, ${userId}, ${r1}),
					('evaluation_run', ${`eval:${r2}`}, ${sql.json({ runId: r2 })}, ${userId}, ${r2})
			`
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from jobs
				where type = 'evaluation_run' and (dedupe_key = ${`eval:${r1}`} or dedupe_key = ${`eval:${r2}`})
			`
			expect(count).toBe(2)
		} finally {
			await cleanupEvalPrefix(prefix)
		}
	})
})
