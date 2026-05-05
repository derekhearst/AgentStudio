import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #19 phase 2 finish — `tasks.repository_id` is declared by-name (no FK), so
 * deleting a repository must NOT cascade-delete tasks. The runner falls back to the
 * agent's legacy workspace + logs a warning when the linked repo is gone. This test
 * pins that contract at the schema level: a task survives a repo delete with a stale
 * `repository_id` pointer that the runtime tolerates.
 *
 * Also pins the `pull_requests` cascade behavior (DOES delete on repo delete — those
 * rows have a real FK so they're transient by definition).
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

test.describe('source-control/cascade — task survives repo delete', () => {
	test('deleting a repository leaves task rows intact with a stale repository_id', async () => {
		const prefix = uniquePrefix('repo-cascade-task')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			const [repo] = await sql<{ id: string }[]>`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values (${userId}, 'github', ${`${prefix}-owner`}, ${`${prefix}-repo`}, 'https://example.com/r.git', 'main', '{}'::jsonb)
				returning id
			`

			const [task] = await sql<{ id: string }[]>`
				insert into tasks (title, spec, repository_id, created_by)
				values (${`${prefix} task`}, 'spec', ${repo.id}, ${userId})
				returning id
			`

			// Delete the repo. By-name pointer means the task row should survive.
			await sql`delete from repositories where id = ${repo.id}`

			const [taskAfter] = await sql<{ id: string; repository_id: string | null }[]>`
				select id, repository_id from tasks where id = ${task.id}
			`
			expect(taskAfter.id).toBe(task.id)
			// Task's repository_id is now a stale pointer (the runner falls back to the agent
			// workspace + logs a warning at run-start; we don't null it out here).
			expect(taskAfter.repository_id).toBe(repo.id)
		} finally {
			await sql`delete from tasks where title like ${`${prefix}%`}`
			await sql`delete from repositories where owner like ${`${prefix}%`}`
		}
	})
})

test.describe('source-control/cascade — pull_requests cascade with their repo', () => {
	test('deleting a repository cascade-deletes its pull_requests rows', async () => {
		const prefix = uniquePrefix('repo-cascade-pr')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			const [repo] = await sql<{ id: string }[]>`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values (${userId}, 'github', ${`${prefix}-owner`}, ${`${prefix}-repo`}, 'https://example.com/r.git', 'main', '{}'::jsonb)
				returning id
			`

			await sql`
				insert into pull_requests (repository_id, provider_pr_number, title, head_branch, base_branch, status)
				values (${repo.id}, 1, ${`${prefix} PR`}, 'feature', 'main', 'open')
			`

			// Sanity check: PR exists.
			let [count] = await sql<{ count: number }[]>`
				select count(*)::int as count from pull_requests where repository_id = ${repo.id}
			`
			expect(count.count).toBe(1)

			// Cascade-delete: dropping the repo takes its PRs with it.
			await sql`delete from repositories where id = ${repo.id}`

			;[count] = await sql<{ count: number }[]>`
				select count(*)::int as count from pull_requests where title like ${`%${prefix}%`}
			`
			expect(count.count).toBe(0)
		} finally {
			await sql`delete from pull_requests where title like ${`%${prefix}%`}`
			await sql`delete from repositories where owner like ${`${prefix}%`}`
		}
	})
})

test.describe('source-control/enum surface — added values accept inserts', () => {
	test('pull_request_ready review item rows accept all relevant payload keys', async () => {
		const prefix = uniquePrefix('enum-pr-ready')
		const sql = getSql()
		try {
			const [item] = await sql<{ payload: { kind?: string; prNumber?: number; status?: string } }[]>`
				insert into review_items (type, severity, summary, payload)
				values (
					'pull_request_ready',
					'warning'::review_item_severity,
					${`${prefix} test PR`},
					${sql.json({ kind: 'pull_request', prNumber: 1, status: 'closed', dedupeKey: `${prefix}-key` })}
				)
				returning payload
			`
			expect(item.payload.kind).toBe('pull_request')
			expect(item.payload.prNumber).toBe(1)
			expect(item.payload.status).toBe('closed')
		} finally {
			await sql`delete from review_items where summary like ${`${prefix}%`}`
		}
	})

	test('automation_summary review item rows accept all relevant payload keys', async () => {
		const prefix = uniquePrefix('enum-auto-summary')
		const sql = getSql()
		try {
			const [item] = await sql<{ payload: { kind?: string; mode?: string; summary?: string } }[]>`
				insert into review_items (type, severity, summary, payload)
				values (
					'automation_summary',
					'info'::review_item_severity,
					${`${prefix} maintenance ran`},
					${sql.json({ kind: 'maintenance_summary', mode: 'maintenance', summary: 'all clear' })}
				)
				returning payload
			`
			expect(item.payload.kind).toBe('maintenance_summary')
			expect(item.payload.mode).toBe('maintenance')
			expect(item.payload.summary).toBe('all clear')
		} finally {
			await sql`delete from review_items where summary like ${`${prefix}%`}`
		}
	})
})
