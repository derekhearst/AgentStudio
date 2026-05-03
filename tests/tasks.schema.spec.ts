import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

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

async function insertTask(
	prefix: string,
	userId: string,
	options: {
		parentTaskId?: string
		status?: string
		priority?: number
		budgetUsd?: string
	} = {},
) {
	const sql = getSql()
	const [task] = await sql<{ id: string }[]>`
		insert into tasks (
			id, title, spec, status, parent_task_id, priority, budget_usd, created_by
		)
		values (
			${randomUUID()},
			${`${prefix} task`},
			${'A test task spec.'},
			${(options.status ?? 'pending')}::task_status,
			${options.parentTaskId ?? null},
			${options.priority ?? 0},
			${options.budgetUsd ?? null},
			${userId}
		)
		returning id
	`
	return task.id
}

test.describe('tasks/schema — basic CRUD', () => {
	test('inserting a task with all fields round-trips correctly', async () => {
		const prefix = uniquePrefix('tasks-insert')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const id = await insertTask(prefix, userId, { status: 'planning', priority: 5, budgetUsd: '12.50' })
			const [row] = await sql<
				{
					title: string
					spec: string
					status: string
					priority: number
					budget_usd: string | null
					metadata: Record<string, unknown>
					created_by: string
				}[]
			>`
				select title, spec, status::text as status, priority, budget_usd, metadata, created_by
				from tasks where id = ${id}
			`
			expect(row.title).toContain(prefix)
			expect(row.status).toBe('planning')
			expect(row.priority).toBe(5)
			expect(parseFloat(row.budget_usd!)).toBe(12.5)
			expect(row.metadata).toEqual({})
			expect(row.created_by).toBe(userId)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('task_status enum rejects unknown values', async () => {
		const prefix = uniquePrefix('tasks-enum')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			let threw = false
			try {
				await sql`
					insert into tasks (title, spec, status, created_by)
					values (${`${prefix} bad`}, ${'spec'}, 'sentinel'::task_status, ${userId})
				`
			} catch {
				threw = true
			}
			expect(threw, 'unknown enum should be rejected').toBe(true)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('parent task FK cascades — deleting a parent removes children', async () => {
		const prefix = uniquePrefix('tasks-cascade')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const parentId = await insertTask(prefix, userId)
			const childId = await insertTask(prefix, userId, { parentTaskId: parentId })
			const grandchildId = await insertTask(prefix, userId, { parentTaskId: childId })

			await sql`delete from tasks where id = ${parentId}`

			const survivors = await sql<{ id: string }[]>`
				select id from tasks where id in (${parentId}, ${childId}, ${grandchildId})
			`
			expect(survivors.length, 'cascading delete should remove parent + child + grandchild').toBe(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('tasks/schema — task_attempts linkage', () => {
	test('inserting an attempt links to a task and orders by attempt_number', async () => {
		const prefix = uniquePrefix('attempts-order')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const taskId = await insertTask(prefix, userId, { status: 'running' })
			for (let i = 1; i <= 3; i++) {
				await sql`
					insert into task_attempts (task_id, attempt_number, status)
					values (${taskId}, ${i}, ${i === 3 ? 'running' : 'failed'}::task_attempt_status)
				`
			}
			const attempts = await sql<{ attempt_number: number; status: string }[]>`
				select attempt_number, status::text as status from task_attempts
				where task_id = ${taskId}
				order by attempt_number asc
			`
			expect(attempts.map((a) => a.attempt_number)).toEqual([1, 2, 3])
			expect(attempts[2].status).toBe('running')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('task delete cascades to its attempts', async () => {
		const prefix = uniquePrefix('attempts-cascade')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const taskId = await insertTask(prefix, userId, { status: 'running' })
			await sql`
				insert into task_attempts (task_id, attempt_number, status)
				values (${taskId}, 1, 'completed'::task_attempt_status)
			`
			await sql`delete from tasks where id = ${taskId}`
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from task_attempts where task_id = ${taskId}
			`
			expect(count).toBe(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('tasks/schema — chat_runs cross-domain linkage', () => {
	test('a chat_run can reference a task + attempt; deleting the task SET NULLs the run pointers', async () => {
		const prefix = uniquePrefix('runs-task-link')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const taskId = await insertTask(prefix, userId, { status: 'running' })
			const [attempt] = await sql<{ id: string }[]>`
				insert into task_attempts (task_id, attempt_number, status)
				values (${taskId}, 1, 'running'::task_attempt_status)
				returning id
			`
			const [conv] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`
			const [run] = await sql<{ id: string }[]>`
				insert into chat_runs (id, conversation_id, user_id, state, source, label, task_id, task_attempt_id)
				values (
					${randomUUID()},
					${conv.id},
					${userId},
					'running'::chat_run_state,
					'chat_stream',
					${`${prefix} run`},
					${taskId},
					${attempt.id}
				)
				returning id
			`

			// Verify the link is real and the FK accepts the assignment.
			const [linked] = await sql<{ task_id: string | null; task_attempt_id: string | null }[]>`
				select task_id, task_attempt_id from chat_runs where id = ${run.id}
			`
			expect(linked.task_id).toBe(taskId)
			expect(linked.task_attempt_id).toBe(attempt.id)

			// Delete the task → chat_run pointers go to null (not cascaded — forensic visibility).
			await sql`delete from tasks where id = ${taskId}`
			const [after] = await sql<{ task_id: string | null; task_attempt_id: string | null }[]>`
				select task_id, task_attempt_id from chat_runs where id = ${run.id}
			`
			expect(after.task_id, 'chat_run.task_id should be NULL after task delete').toBeNull()
			expect(after.task_attempt_id, 'chat_run.task_attempt_id should be NULL after task delete').toBeNull()

			// The chat_run row itself survives (forensic visibility).
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from chat_runs where id = ${run.id}
			`
			expect(count, 'chat_run row should survive task deletion').toBe(1)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
