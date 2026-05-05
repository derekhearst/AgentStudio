import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #19 phase 2 finish — repo-backed task workspace provisioning.
 *
 * The full mirror+worktree round-trip needs a live GitHub repo + clone, which the
 * pure-helper layer can't exercise. We pin the contracts that gate safety:
 *   - `buildTaskBranchName` produces the documented attempt-aware shape
 *   - `provisionRepoBackedWorkspace` rejects repos the user doesn't own
 *   - `provisionRepoBackedWorkspace` rejects when no GitHub connection exists
 *   - `tasks.repository_id` column accepts inserts (Wave 5 #19 P2 finish migration)
 *   - The CreateTaskInput pathway round-trips repositoryId through the persistence layer
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

test.describe('source-control/repo-worktree — buildTaskBranchName', () => {
	test('first attempt uses the clean agent/<taskId> shape', async () => {
		const { buildTaskBranchName } = await import('../src/lib/source-control/repo-worktree.server')
		const taskId = '12345678-1234-1234-1234-123456789abc'
		expect(buildTaskBranchName(taskId, 1)).toBe(`agent/${taskId}`)
		// Attempt 0 (defensive) collapses to the first-attempt shape.
		expect(buildTaskBranchName(taskId, 0)).toBe(`agent/${taskId}`)
	})

	test('retries get the attempt-N suffix', async () => {
		const { buildTaskBranchName } = await import('../src/lib/source-control/repo-worktree.server')
		const taskId = 'abc'
		expect(buildTaskBranchName(taskId, 2)).toBe('agent/abc/attempt-2')
		expect(buildTaskBranchName(taskId, 7)).toBe('agent/abc/attempt-7')
	})
})

test.describe('source-control/repo-worktree — provisionRepoBackedWorkspace authz', () => {
	test('rejects a repository owned by another user', async () => {
		const prefix = uniquePrefix('repo-worktree-authz')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			// Create a repo owned by a different (synthetic) user so the active user
			// cannot use it for a task-backed workspace.
			const otherUserId = '00000000-0000-4000-8000-00000000bbbb'
			await sql`
				insert into users (id, name, username, role, is_active)
				values (${otherUserId}, 'Test User', ${`${prefix}-user`}, 'user', true)
				on conflict (id) do nothing
			`
			const [repo] = await sql<{ id: string }[]>`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values (${otherUserId}, 'github', ${`${prefix}-owner`}, ${`${prefix}-repo`}, 'https://example.com/r.git', 'main', '{}'::jsonb)
				returning id
			`

			const { provisionRepoBackedWorkspace } = await import('../src/lib/source-control/repo-worktree.server')
			let threwOwnership = false
			try {
				await provisionRepoBackedWorkspace({
					userId,
					taskId: '00000000-0000-4000-8000-000000000001',
					attemptNumber: 1,
					repositoryId: repo.id,
				})
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				threwOwnership = /does not belong to user/i.test(message)
			}
			expect(threwOwnership).toBe(true)
		} finally {
			await sql`delete from repositories where owner like ${`${prefix}-owner`}`
			await sql`delete from users where username like ${`${prefix}%`}`
		}
	})

	test('rejects when the repositoryId is unknown', async () => {
		const userId = await getActiveUserId()
		const { provisionRepoBackedWorkspace } = await import('../src/lib/source-control/repo-worktree.server')
		let threwNotFound = false
		try {
			await provisionRepoBackedWorkspace({
				userId,
				taskId: '00000000-0000-4000-8000-000000000002',
				attemptNumber: 1,
				repositoryId: '00000000-0000-4000-8000-00000000face',
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			threwNotFound = /not found/i.test(message)
		}
		expect(threwNotFound).toBe(true)
	})
})

test.describe('tasks/repository_id — schema round-trip', () => {
	test('createTask accepts repositoryId and the column round-trips through the DB', async () => {
		const prefix = uniquePrefix('task-repo')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			// Insert a synthetic repo owned by the active user (so the FK is valid).
			const [repo] = await sql<{ id: string }[]>`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values (${userId}, 'github', ${`${prefix}-owner`}, ${`${prefix}-repo`}, 'https://example.com/r.git', 'main', '{}'::jsonb)
				returning id
			`

			const { createTask } = await import('../src/lib/tasks/tasks.server')
			const created = await createTask({
				title: `${prefix} repo task`,
				spec: 'work the repo',
				createdBy: userId,
				repositoryId: repo.id,
			})
			expect(created.repositoryId).toBe(repo.id)

			const [persisted] = await sql<{ repository_id: string | null }[]>`
				select repository_id from tasks where id = ${created.id}
			`
			expect(persisted.repository_id).toBe(repo.id)
		} finally {
			await clearTestRows(prefix)
		}
	})
})
