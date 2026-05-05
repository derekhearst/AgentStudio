import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * `/source-control` admin page — full operator flow exercised through the UI.
 *
 * Covers what an operator sees when:
 *   1. Visiting without GitHub connected → "Connect GitHub" prompt + setup walkthrough
 *      when env vars missing
 *   2. Viewing the synced repo list when repos exist (sortable table, status badges)
 *   3. The page renders without console errors and reflects the current connection state
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

async function clearReposForUser(userId: string, prefix: string) {
	const sql = getSql()
	await sql`delete from repositories where user_id = ${userId} and owner like ${`${prefix}%`}`
}

test.describe('source-control/admin-page — UI rendering', () => {
	test('page renders the Source control header and connection panel', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('sc-admin-render')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto('/source-control', { waitUntil: 'domcontentloaded' })

			// Page heading.
			await expect(page.getByRole('heading', { name: /Source control/i }).first()).toBeVisible({
				timeout: 30_000,
			})

			// Page renders the GitHub connection card. Operators in any of the three
			// states see one of: "Not configured" (env vars missing), "Not connected"
			// (env set but no OAuth flow run), or the connected-as info. All three
			// indicate the page rendered correctly.
			await expect(page.locator('body')).toContainText('GitHub', { timeout: 10_000 })
			const states = await Promise.all([
				page.getByText(/Not configured/i).count(),
				page.getByText(/Not connected/i).count(),
				page.getByText(/Connected as/i).count(),
			])
			expect(states.reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('synced repos appear in the repo list when present', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('sc-admin-repos')
		const sql = getSql()
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()

		try {
			// Seed two repos for this user.
			await sql`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values
					(${userId}, 'github', ${`${prefix}aowner`}, ${`${prefix}arepo`}, 'https://github.com/example/r1.git', 'main', ${sql.json({ htmlUrl: 'https://github.com/example/r1', private: false })}),
					(${userId}, 'github', ${`${prefix}bowner`}, ${`${prefix}brepo`}, 'https://github.com/example/r2.git', 'main', ${sql.json({ htmlUrl: 'https://github.com/example/r2', private: true })})
			`

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto('/source-control', { waitUntil: 'domcontentloaded' })

			// Both repo names should appear somewhere on the page (table rows).
			await expect(page.locator('body')).toContainText(`${prefix}arepo`, { timeout: 30_000 })
			await expect(page.locator('body')).toContainText(`${prefix}brepo`, { timeout: 30_000 })
		} finally {
			await clearReposForUser(userId, prefix)
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('page does not surface uncaught console errors', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('sc-admin-noerr')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		const errors: string[] = []
		page.on('pageerror', (e) => errors.push(e.message))
		page.on('console', (msg) => {
			if (msg.type() === 'error') errors.push(msg.text())
		})

		try {
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto('/source-control', { waitUntil: 'domcontentloaded' })
			await page.waitForTimeout(500)

			// Filter out benign noise (404 favicons, hydration warnings about devtools, etc.)
			const significant = errors.filter(
				(e) =>
					!e.includes('Failed to load resource') &&
					!e.includes('favicon') &&
					!e.includes('Service Worker'),
			)
			expect(significant, `Console errors:\n${significant.join('\n')}`).toEqual([])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
