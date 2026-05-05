import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #19 phase 2 finish (UI surface) — `setTaskRepositoryCommand` ownership +
 * round-trip contract.
 *
 * The remote function lives behind authenticated SvelteKit hooks, so end-to-end exercise
 * needs a logged-in session. These tests pin the underlying server contract: the
 * persistence layer accepts attach/detach round-trips, and the `repositoryId` column is
 * indexed for the kanban filter (Wave 5 #19 P2 finish migration).
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

async function clearTestRows(prefix: string) {
	const sql = getSql()
	await sql`delete from task_attempts where task_id in (select id from tasks where title like ${`${prefix}%`})`
	await sql`delete from tasks where title like ${`${prefix}%`}`
	await sql`delete from repositories where owner like ${`${prefix}%`}`
}

test.describe('tasks/repository-link — round-trip', () => {
	test('attach + detach a repository round-trips through the tasks.repository_id column', async () => {
		const prefix = uniquePrefix('task-repo-link')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			const [repo] = await sql<{ id: string }[]>`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values (${userId}, 'github', ${`${prefix}-owner`}, ${`${prefix}-repo`}, 'https://example.com/r.git', 'main', '{}'::jsonb)
				returning id
			`

			const { createTask } = await import('../src/lib/tasks/tasks.server')
			const task = await createTask({
				title: `${prefix} attach test`,
				spec: 'do something',
				createdBy: userId,
			})
			expect(task.repositoryId).toBeNull()

			// Attach via direct UPDATE (the remote command needs an auth context).
			await sql`update tasks set repository_id = ${repo.id} where id = ${task.id}`
			let [persisted] = await sql<{ repository_id: string | null }[]>`
				select repository_id from tasks where id = ${task.id}
			`
			expect(persisted.repository_id).toBe(repo.id)

			// Detach.
			await sql`update tasks set repository_id = null where id = ${task.id}`
			;[persisted] = await sql<{ repository_id: string | null }[]>`
				select repository_id from tasks where id = ${task.id}
			`
			expect(persisted.repository_id).toBeNull()
		} finally {
			await clearTestRows(prefix)
		}
	})

	test('tasks_repository_idx index supports per-repo lookup', async () => {
		// Confirms the migration added the index — without it, a "show me all tasks for this
		// repo" filter would degrade as task counts grow.
		const sql = getSql()
		const [idx] = await sql<{ indexname: string }[]>`
			select indexname from pg_indexes
			where tablename = 'tasks' and indexname = 'tasks_repository_idx'
		`
		expect(idx?.indexname).toBe('tasks_repository_idx')
	})
})

test.describe('tasks/repository-link — listConnectedRepositoriesQuery shape', () => {
	test('returns the documented surface fields per repo', async () => {
		const prefix = uniquePrefix('task-repo-list')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			await sql`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values (
					${userId},
					'github',
					${`${prefix}-owner`},
					${`${prefix}-repo`},
					'https://github.com/example/repo.git',
					'main',
					${sql.json({ htmlUrl: 'https://github.com/example/repo', private: true })}
				)
			`

			const { listRepositories } = await import('../src/lib/source-control/source-control.server')
			const repos = await listRepositories(userId)
			const fixture = repos.find((r) => r.owner === `${prefix}-owner`)
			expect(fixture).toBeDefined()
			expect(fixture!.name).toBe(`${prefix}-repo`)
			expect(fixture!.defaultBranch).toBe('main')
			const meta = (fixture!.metadata ?? {}) as { htmlUrl?: string; private?: boolean }
			expect(meta.htmlUrl).toBe('https://github.com/example/repo')
			expect(meta.private).toBe(true)
		} finally {
			await clearTestRows(prefix)
		}
	})
})
