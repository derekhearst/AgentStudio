import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * Wave 2 #11 phase 5 — schema-level invariants for the task runner's write shape.
 *
 * The runner's live LLM execution path is exercised by `tests/automations.runtime.spec.ts` (the
 * agent-backed automation test goes through the same `runChatLoop` + detached Session). This
 * spec covers the SCHEMA invariants the runner relies on: a task can transition from a terminal
 * status back to `running` for retry, an attempt can carry cost + error, and the run/attempt
 * linkage round-trips.
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

async function setupAgent(prefix: string) {
	const sql = getSql()
	const [agent] = await sql<{ id: string }[]>`
		insert into agents (id, name, role, system_prompt, model, status, config)
		values (
			${randomUUID()},
			${`${prefix} runner agent`},
			${'tester'},
			${'You execute small tasks. Respond in one short sentence.'},
			${'anthropic/claude-sonnet-4'},
			'active'::agent_status,
			${sql.json({})}
		)
		returning id
	`
	return agent.id
}

async function setupTask(
	prefix: string,
	userId: string,
	agentId: string,
	startStatus: string = 'failed',
) {
	const sql = getSql()
	const [conv] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, agent_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, ${agentId}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id
	`
	const [task] = await sql<{ id: string }[]>`
		insert into tasks (
			id, title, spec, status, owner_agent_id, root_conversation_id, created_by, metadata
		)
		values (
			${randomUUID()},
			${`${prefix} retry me`},
			${`${prefix}: respond with the single word "ok"`},
			${startStatus}::task_status,
			${agentId},
			${conv.id},
			${userId},
			${sql.json({})}
		)
		returning id
	`
	return { conversationId: conv.id, taskId: task.id }
}

test.describe('tasks/runner — retry-flow schema invariants', () => {
	test('a failed task can transition back to running for retry, then to completed', async () => {
		const prefix = uniquePrefix('runner-retry-flow')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const agentId = await setupAgent(prefix)
			const { taskId } = await setupTask(prefix, userId, agentId, 'failed')

			// First attempt — failed.
			await sql`
				insert into task_attempts (task_id, attempt_number, status, error, finished_at)
				values (${taskId}, 1, 'failed'::task_attempt_status, 'simulated failure', now())
			`

			// Retry: bump task back to running, insert attempt #2.
			await sql`update tasks set status = 'running'::task_status, updated_at = now() where id = ${taskId}`
			await sql`
				insert into task_attempts (task_id, attempt_number, status, started_at)
				values (${taskId}, 2, 'running'::task_attempt_status, now())
			`

			// Complete the retry.
			await sql`
				update task_attempts set status = 'completed'::task_attempt_status, cost_usd = '0.0042', finished_at = now()
				where task_id = ${taskId} and attempt_number = 2
			`
			await sql`update tasks set status = 'completed'::task_status, updated_at = now() where id = ${taskId}`

			const attempts = await sql<{ attempt_number: number; status: string; cost_usd: string | null }[]>`
				select attempt_number, status::text as status, cost_usd from task_attempts
				where task_id = ${taskId}
				order by attempt_number asc
			`
			expect(attempts.map((a) => a.status)).toEqual(['failed', 'completed'])
			expect(parseFloat(attempts[1].cost_usd!)).toBeCloseTo(0.0042, 4)

			const [taskFinal] = await sql<{ status: string }[]>`
				select status::text as status from tasks where id = ${taskId}
			`
			expect(taskFinal.status).toBe('completed')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a chat_run attached to a task_attempt round-trips both linkages', async () => {
		const prefix = uniquePrefix('runner-run-attempt-link')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const agentId = await setupAgent(prefix)
			const { conversationId, taskId } = await setupTask(prefix, userId, agentId, 'running')
			const [attempt] = await sql<{ id: string }[]>`
				insert into task_attempts (task_id, attempt_number, status)
				values (${taskId}, 1, 'running'::task_attempt_status)
				returning id
			`
			const [run] = await sql<{ id: string }[]>`
				insert into chat_runs (
					id, conversation_id, user_id, agent_id, state, source, label, task_id, task_attempt_id
				)
				values (
					${randomUUID()},
					${conversationId},
					${userId},
					${agentId},
					'running'::chat_run_state,
					'automation',
					${`${prefix} retry run`},
					${taskId},
					${attempt.id}
				)
				returning id
			`
			const [linked] = await sql<{ task_id: string | null; task_attempt_id: string | null; source: string }[]>`
				select task_id, task_attempt_id, source::text as source from chat_runs where id = ${run.id}
			`
			expect(linked.task_id).toBe(taskId)
			expect(linked.task_attempt_id).toBe(attempt.id)
			expect(linked.source).toBe('automation')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a task without an ownerAgentId would fail the runner precondition (executeTaskOnce throws)', async () => {
		const prefix = uniquePrefix('runner-no-agent')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [task] = await sql<{ id: string; owner_agent_id: string | null }[]>`
				insert into tasks (id, title, spec, status, created_by, metadata)
				values (
					${randomUUID()},
					${`${prefix} no agent`},
					${'no spec'},
					'pending'::task_status,
					${userId},
					${sql.json({})}
				)
				returning id, owner_agent_id
			`
			expect(task.owner_agent_id, 'precondition: task with no owner agent').toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
