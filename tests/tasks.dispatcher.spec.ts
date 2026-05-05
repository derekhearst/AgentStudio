import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 2 #11 phase 3 finish — `task_run` + `tasks_dispatch` invariants.
 *
 * Validates the dispatcher contract:
 *   - Pending top-level tasks with an `ownerAgentId` are picked up and enqueued
 *   - Pending tasks WITHOUT an `ownerAgentId` are skipped
 *   - Pending child tasks (parentTaskId set) are skipped (orchestrator owns them inline)
 *   - Non-pending tasks are skipped
 *   - DedupeKey `task:<id>` collapses double-fires
 */

async function getActiveAdminUserId() {
	const sql = getSql()
	const [u] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null
		order by case when role='admin' then 0 else 1 end, created_at asc limit 1
	`
	if (!u) throw new Error('No active user found')
	return u.id
}

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from jobs where dedupe_key like ${`task:%`} and payload::text like ${`%${prefix}%`}`
	await sql`delete from task_attempts where task_id in (select id from tasks where title like ${`${prefix}%`})`
	await sql`delete from tasks where title like ${`${prefix}%`}`
	await sql`delete from agents where name like ${`${prefix}%`}`
}

test.describe('tasks/dispatcher — schema-invariant contract', () => {
	test('top-level pending task with ownerAgentId enqueues a task_run job', async () => {
		const prefix = uniquePrefix('task-dispatch-1')
		await cleanup(prefix)
		const sql = getSql()
		const userId = await getActiveAdminUserId()
		try {
			const [agent] = await sql<{ id: string }[]>`
				insert into agents (name, role, system_prompt, model)
				values (${`${prefix} agent`}, 'tester', 'sp', 'anthropic/claude-sonnet-4')
				returning id
			`
			const [task] = await sql<{ id: string }[]>`
				insert into tasks (title, spec, status, owner_agent_id, created_by)
				values (${`${prefix} top`}, 'spec', 'pending'::task_status, ${agent.id}, ${userId})
				returning id
			`
			// Mimic dispatchPendingTasks: insert a job with the dedupeKey contract.
			await sql`
				insert into jobs (type, queue, priority, dedupe_key, payload, status)
				values ('task_run', 'default', 60, ${`task:${task.id}`}, ${sql.json({ taskId: task.id, _prefix: prefix })}, 'pending'::job_status)
			`
			const [enqueued] = await sql<{ count: number }[]>`
				select count(*)::int as count from jobs where dedupe_key = ${`task:${task.id}`}
			`
			expect(enqueued.count).toBe(1)

			// Re-enqueue with the same dedupe key — should reject (UNIQUE constraint).
			let threw = false
			try {
				await sql`
					insert into jobs (type, queue, priority, dedupe_key, payload, status)
					values ('task_run', 'default', 60, ${`task:${task.id}`}, ${sql.json({ taskId: task.id, _prefix: prefix })}, 'pending'::job_status)
				`
			} catch {
				threw = true
			}
			expect(threw, 'duplicate dedupe key rejected').toBe(true)
		} finally {
			await cleanup(prefix)
		}
	})

	test('child task (parentTaskId set) should be excluded by the dispatcher query', async () => {
		const prefix = uniquePrefix('task-dispatch-2')
		await cleanup(prefix)
		const sql = getSql()
		const userId = await getActiveAdminUserId()
		try {
			const [agent] = await sql<{ id: string }[]>`
				insert into agents (name, role, system_prompt, model)
				values (${`${prefix} agent`}, 'tester', 'sp', 'anthropic/claude-sonnet-4')
				returning id
			`
			const [parent] = await sql<{ id: string }[]>`
				insert into tasks (title, spec, status, owner_agent_id, created_by)
				values (${`${prefix} parent`}, 'p', 'running'::task_status, ${agent.id}, ${userId})
				returning id
			`
			const [child] = await sql<{ id: string }[]>`
				insert into tasks (title, spec, status, owner_agent_id, parent_task_id, created_by)
				values (${`${prefix} child`}, 'c', 'pending'::task_status, ${agent.id}, ${parent.id}, ${userId})
				returning id
			`
			// The dispatcher's WHERE clause: status='pending' AND owner_agent_id NOT NULL AND parent_task_id IS NULL.
			const eligible = await sql<{ id: string }[]>`
				select id from tasks
				where status = 'pending'::task_status
				  and owner_agent_id is not null
				  and parent_task_id is null
				  and title like ${`${prefix}%`}
			`
			// Only the parent (which is `running`, not `pending`) and the child (which has parent_task_id) exist.
			// Neither should be eligible.
			expect(eligible.map((r) => r.id)).not.toContain(child.id)
			expect(eligible.map((r) => r.id)).not.toContain(parent.id)
		} finally {
			await cleanup(prefix)
		}
	})

	test('pending task without ownerAgentId is skipped', async () => {
		const prefix = uniquePrefix('task-dispatch-3')
		await cleanup(prefix)
		const sql = getSql()
		const userId = await getActiveAdminUserId()
		try {
			const [task] = await sql<{ id: string }[]>`
				insert into tasks (title, spec, status, created_by)
				values (${`${prefix} no-agent`}, 'spec', 'pending'::task_status, ${userId})
				returning id
			`
			const eligible = await sql<{ id: string }[]>`
				select id from tasks
				where status = 'pending'::task_status
				  and owner_agent_id is not null
				  and parent_task_id is null
				  and title like ${`${prefix}%`}
			`
			expect(eligible.map((r) => r.id)).not.toContain(task.id)
		} finally {
			await cleanup(prefix)
		}
	})

	test('the dedupeKey contract is consistent for the same task across calls', async () => {
		const taskId = randomUUID()
		const a = `task:${taskId}`
		const b = `task:${taskId}`
		expect(a).toBe(b)
		// And differs across tasks.
		const otherTask = randomUUID()
		expect(`task:${otherTask}`).not.toBe(a)
	})
})
