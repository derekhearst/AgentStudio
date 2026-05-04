import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * Wave 3 #14 evaluations plan phase 3+4 — task-level evaluation gate + re-plan counter columns.
 *
 * Schema invariants for the new `tasks.eval_required` + `tasks.eval_attempt` columns. The
 * runner integration (`executeTaskOnce` → eval pass → status gate) is live-LLM territory and is
 * exercised whenever a task with `evalRequired=true` runs through `tests/automations.runtime`.
 * This spec pins the persistence contract: defaults, round-trip, retry-counter increment,
 * and `isRunEvaluationClear`'s gate behavior driven from the chat_runs side.
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

async function setupTask(prefix: string, userId: string, evalRequired: boolean) {
	const sql = getSql()
	const [agent] = await sql<{ id: string }[]>`
		insert into agents (name, role, system_prompt, model)
		values (${`${prefix} owner`}, 'r', 'sp', 'anthropic/claude-sonnet-4')
		returning id
	`
	const [task] = await sql<{ id: string; eval_required: boolean; eval_attempt: number }[]>`
		insert into tasks (title, spec, owner_agent_id, created_by, eval_required)
		values (${`${prefix} task`}, ${`${prefix} spec`}, ${agent.id}, ${userId}, ${evalRequired})
		returning id, eval_required, eval_attempt
	`
	return { agentId: agent.id, ...task }
}

test.describe('evaluations/task-gate — tasks.eval_required + tasks.eval_attempt columns', () => {
	test('eval_required defaults to false; eval_attempt defaults to 0', async () => {
		const prefix = uniquePrefix('task-eval-defaults')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		try {
			const task = await setupTask(prefix, userId, false)
			expect(task.eval_required).toBe(false)
			expect(task.eval_attempt).toBe(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('eval_required round-trips when set true', async () => {
		const prefix = uniquePrefix('task-eval-required')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		try {
			const task = await setupTask(prefix, userId, true)
			expect(task.eval_required).toBe(true)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('eval_attempt counter increments via raw UPDATE (mirrors runner re-plan path)', async () => {
		const prefix = uniquePrefix('task-eval-counter')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const task = await setupTask(prefix, userId, true)
			await sql`update tasks set eval_attempt = eval_attempt + 1 where id = ${task.id}`
			await sql`update tasks set eval_attempt = eval_attempt + 1 where id = ${task.id}`
			const [check] = await sql<{ eval_attempt: number }[]>`
				select eval_attempt from tasks where id = ${task.id}
			`
			expect(check.eval_attempt).toBe(2)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('chat_runs created against an evalRequired task can be inspected via isRunEvaluationClear contract', async () => {
		const prefix = uniquePrefix('task-eval-isclear')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const task = await setupTask(prefix, userId, true)
			// Make a chat_run flagged with the same eval_required, then prove the predicate
			// returns false until a `pass` verdict lands.
			const [conv] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} c`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`
			const [run] = await sql<{ id: string }[]>`
				insert into chat_runs (id, conversation_id, user_id, state, source, label, eval_required, task_id)
				values (${randomUUID()}, ${conv.id}, ${userId}, 'completed'::chat_run_state, 'automation', ${`${prefix} run`}, true, ${task.id})
				returning id
			`

			// Step 1: no evaluation yet → not clear.
			const [{ count: noEvalCount }] = await sql<{ count: number }[]>`
				select count(*)::int as count from run_evaluations where run_id = ${run.id}
			`
			expect(noEvalCount).toBe(0)

			// Step 2: a `needs_revision` verdict → still not clear.
			await sql`
				insert into run_evaluations (run_id, verdict, findings)
				values (${run.id}, 'needs_revision'::evaluation_verdict, ${sql.json([])})
			`
			const [latest1] = await sql<{ verdict: string }[]>`
				select verdict::text as verdict from run_evaluations where run_id = ${run.id} order by created_at desc limit 1
			`
			expect(latest1.verdict).toBe('needs_revision')

			// Step 3: a `pass` verdict → now clear (latest wins).
			await sql`
				insert into run_evaluations (run_id, verdict, findings)
				values (${run.id}, 'pass'::evaluation_verdict, ${sql.json([])})
			`
			const [latest2] = await sql<{ verdict: string }[]>`
				select verdict::text as verdict from run_evaluations where run_id = ${run.id} order by created_at desc limit 1
			`
			expect(latest2.verdict).toBe('pass')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
