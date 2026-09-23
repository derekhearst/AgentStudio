import { expect, test } from '@playwright/test'
import {
	acquireGlobalStateLock,
	authenticateContext,
	cleanupExtendedPrefix,
	getActiveUserId,
	getSql,
	seedSkill,
	uniquePrefix,
	waitForHydration,
} from './helpers'

/**
 * /skills tells "loading", "nothing matches" and "no skills" apart.
 *
 * It used to show "No skills yet. Start a guided creation chat to create one." whenever
 * the filtered list was empty: while the list was still loading, and when a search simply
 * matched nothing — to a user with forty skills. And no control on the page started that
 * chat. The empty-list case itself cannot be produced here (the built-in skills are always
 * listed), so these cover the other two and the button the message points at.
 */

test.describe('/skills list states', () => {
	test('a search with no matches says so, and can be cleared', async ({ page }) => {
		const prefix = uniquePrefix('skills-nomatch')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(page.context())
		const seed = await seedSkill(prefix)

		try {
			await page.goto('/skills')
			await waitForHydration(page)
			await expect(page.locator('a').filter({ hasText: seed.name })).toBeVisible()

			const query = `zzz-${Date.now()}`
			await page.getByPlaceholder('Search skills...').fill(query)
			await expect(page.getByText(`No skills match "${query}".`)).toBeVisible()
			await expect(page.getByText('No skills yet', { exact: false })).toHaveCount(0)

			await page.getByRole('button', { name: 'Clear search' }).click()
			await expect(page.locator('a').filter({ hasText: seed.name })).toBeVisible()
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})

	test('shows a spinner, not "No skills yet", while the list loads', async ({ page }) => {
		await authenticateContext(page.context())
		let release: () => void = () => {}
		const held = new Promise<void>((resolve) => (release = resolve))
		await page.route(/\/_app\/remote\/[^/]+\/listSkillsQuery/, async (route) => {
			await held
			await route.continue()
		})

		await page.goto('/skills')
		await expect(page.locator('.loading-spinner').first()).toBeVisible()
		await expect(page.getByText('No skills yet', { exact: false })).toHaveCount(0)

		release()
		await expect(page.locator('.loading-spinner')).toHaveCount(0)
		await expect(page.locator('a[href^="/skills/"]').first()).toBeVisible()
	})

	test('+ New skill opens the guided creation chat', async ({ page }) => {
		// The chat page sends the opening prompt, which starts a model run, so this holds the
		// budget lock like every other spec that runs the model (see agents.spec.ts).
		const releaseBudgetLock = await acquireGlobalStateLock('budget-state')
		const sql = getSql()
		const userId = await getActiveUserId()
		let conversationId: string | undefined

		try {
			await authenticateContext(page.context())
			await page.goto('/skills')
			await waitForHydration(page)
			await page.getByRole('button', { name: '+ New skill' }).click()
			await page.waitForURL(/\/chat\/[0-9a-f-]+/, { timeout: 30_000 })

			// This click's conversation, by the id in the URL. Counting "Create skill" rows by
			// time also counted, and then deleted, one another worker was still streaming —
			// this file's own mobile run among them.
			conversationId = /\/chat\/([0-9a-f-]+)/.exec(new URL(page.url()).pathname)?.[1]
			expect(conversationId).toBeTruthy()
			const rows = await sql<{ title: string }[]>`
				select title from conversations where id = ${conversationId!} and user_id = ${userId}
			`
			expect(rows.map((row) => row.title)).toEqual(['Create skill'])

			// A deliberate click, so the list stays in history: Back returns to it.
			await page.goBack()
			await expect(page).toHaveURL(/\/skills$/)
		} finally {
			if (conversationId) await sql`delete from conversations where id = ${conversationId} and user_id = ${userId}`
			await releaseBudgetLock()
		}
	})
})
