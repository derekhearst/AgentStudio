import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #19 phase 2 finish — UI integration tests for the /tasks/[id] repository picker.
 *
 * Covers the operator flow that ties the source-control story together end-to-end:
 *   1. Task is created without a repo → picker shows "Attach"
 *   2. Operator opens the picker → list of synced repos appears
 *   3. Operator picks a repo → tasks.repository_id is set + UI shows the linked badge
 *   4. Operator clicks Detach → tasks.repository_id returns to null + picker reverts
 *
 * Auth via the standard E2E session-cookie helper. DB fixtures via getSql().
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

async function seedRepoForUser(_prefix: string, userId: string, suffix: string) {
	// Use a short alphanumeric owner/name so getByText matchers don't trip on the colons
	// in the unique prefix. The test asserts on the rendered UI; we cleanup by id below.
	const sql = getSql()
	const owner = `t${suffix}owner`.toLowerCase().slice(0, 30)
	const name = `t${suffix}repo`.toLowerCase().slice(0, 30)
	const [row] = await sql<{ id: string; owner: string; name: string }[]>`
		insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
		values (
			${userId},
			'github',
			${owner},
			${name},
			'https://github.com/example/repo.git',
			'main',
			${sql.json({ htmlUrl: 'https://github.com/example/repo', private: false })}
		)
		returning id, owner, name
	`
	return row
}

async function seedTaskForUser(prefix: string, userId: string) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into tasks (title, spec, status, created_by)
		values (${`${prefix} repo task`}, 'Test task spec', 'pending', ${userId})
		returning id
	`
	return row
}

async function clearTestRows(prefix: string, repoId: string | null = null) {
	const sql = getSql()
	await sql`delete from task_attempts where task_id in (select id from tasks where title like ${`${prefix}%`})`
	await sql`delete from tasks where title like ${`${prefix}%`}`
	if (repoId) {
		await sql`delete from repositories where id = ${repoId}`
	}
}

test.describe('tasks/repo-picker — UI flow', () => {
	test('operator can attach a repo, the badge shows, then detach reverts to none', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('task-picker-attach')
		const suffix = Math.random().toString(36).slice(2, 8)
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()
		const sql = getSql()
		let repoId: string | null = null

		try {
			const repo = await seedRepoForUser(prefix, userId, suffix)
			repoId = repo.id
			const task = await seedTaskForUser(prefix, userId)

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/tasks/${task.id}`, { waitUntil: 'domcontentloaded' })

			// Repository row should render with "none" + "Attach" button initially.
			const repoLabel = page.getByText('Repository:').first()
			await repoLabel.waitFor({ state: 'visible', timeout: 30_000 })
			const attachButton = page.getByRole('button', { name: /^Attach$/ })
			await expect(attachButton).toBeVisible()

			// Open the picker — connected repos should appear as chips.
			await attachButton.click()
			const repoChip = page.getByRole('button', { name: new RegExp(`${repo.owner}/${repo.name}`) })
			await repoChip.waitFor({ state: 'visible', timeout: 10_000 })

			// Click the chip → setTaskRepositoryCommand fires → DB updates.
			const setRepoResponse = page.waitForResponse(
				(r) => r.url().includes('setTaskRepositoryCommand') && r.status() === 200,
				{ timeout: 10_000 },
			)
			await repoChip.click()
			await setRepoResponse

			// Verify DB.
			let [persisted] = await sql<{ repository_id: string | null }[]>`
				select repository_id from tasks where id = ${task.id}
			`
			expect(persisted.repository_id).toBe(repo.id)

			// UI should show the Detach button (which only renders when linkedRepo is set).
			const detachButton = page.getByRole('button', { name: /^Detach$/ })
			await detachButton.waitFor({ state: 'visible', timeout: 15_000 })
			// And the linked badge should show owner/name as a substring of page text.
			await expect(page.locator('body')).toContainText(`${repo.owner}/${repo.name}`)

			// Detach round-trip.
			const detachResponse = page.waitForResponse(
				(r) => r.url().includes('setTaskRepositoryCommand') && r.status() === 200,
				{ timeout: 10_000 },
			)
			await detachButton.click()
			await detachResponse

			;[persisted] = await sql<{ repository_id: string | null }[]>`
				select repository_id from tasks where id = ${task.id}
			`
			expect(persisted.repository_id).toBeNull()

			// "Attach" button is back.
			await expect(page.getByRole('button', { name: /^Attach$/ })).toBeVisible({ timeout: 10_000 })
		} finally {
			await clearTestRows(prefix, repoId)
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('attempting to attach when no repos are connected shows the connect prompt', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('task-picker-empty')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()
		const sql = getSql()

		try {
			// Pre-clear any repos this user has so the picker hits the empty state.
			await sql`delete from repositories where user_id = ${userId} and owner not like 'system%'`
			const task = await seedTaskForUser(prefix, userId)

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/tasks/${task.id}`, { waitUntil: 'domcontentloaded' })

			const attachButton = page.getByRole('button', { name: /^Attach$/ })
			await attachButton.waitFor({ state: 'visible', timeout: 30_000 })
			await attachButton.click()

			// Empty state copy + link to /source-control.
			const emptyMessage = page.getByText(/No repos synced/i)
			await emptyMessage.waitFor({ state: 'visible', timeout: 10_000 })
			const connectLink = page.getByRole('link', { name: /Connect GitHub/i })
			await expect(connectLink).toBeVisible()
			await expect(connectLink).toHaveAttribute('href', '/source-control')
		} finally {
			await clearTestRows(prefix, null)
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a stale repository_id (linked repo deleted) renders the missing-repo warning', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('task-picker-stale')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()
		const sql = getSql()

		try {
			const suffix = Math.random().toString(36).slice(2, 8)
			const repo = await seedRepoForUser(prefix, userId, suffix)
			const task = await seedTaskForUser(prefix, userId)

			// Link the task to the repo, then delete the repo (the by-name pointer leaves
			// task.repository_id stale).
			await sql`update tasks set repository_id = ${repo.id} where id = ${task.id}`
			await sql`delete from repositories where id = ${repo.id}`

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/tasks/${task.id}`, { waitUntil: 'domcontentloaded' })

			// "missing repo" warning + Detach button visible.
			const missingBadge = page.getByText(/missing repo/i)
			await missingBadge.waitFor({ state: 'visible', timeout: 30_000 })
			await expect(page.getByRole('button', { name: /^Detach$/ })).toBeVisible()
		} finally {
			await clearTestRows(prefix, null)
			await cleanupPrefixedRecords(prefix)
		}
	})
})
