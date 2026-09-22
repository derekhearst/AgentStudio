import { expect, test } from '@playwright/test'
import {
	answerConfirmDialog,
	authenticateContext,
	cleanupPrefixedRecords,
	getActiveUserId,
	getSql,
	uniquePrefix,
	waitForHydration,
} from './helpers'

/**
 * The confirm dialog that replaced `window.confirm()` across thirteen call sites.
 *
 * The accept path is covered incidentally by the CRUD specs, which have to get past a
 * confirm to delete anything. What had no coverage at all — with the native dialog or
 * without it — is everything else: that declining actually aborts, that Escape and the
 * backdrop count as declining, and that the destructive variant is reachable by role.
 *
 * `/projects` is the vehicle because deleting a project is the plainest of the thirteen:
 * one row, one button, and the database says unambiguously whether it happened.
 */

async function seedProject(prefix: string) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [project] = await sql<{ id: string }[]>`
		insert into projects (user_id, name, slug)
		values (${userId}, ${`${prefix} Project`}, ${`${prefix}-project`})
		returning id
	`
	return project.id
}

const projectCount = async (id: string) => {
	const sql = getSql()
	const [row] = await sql<{ count: number }[]>`select count(*)::int as count from projects where id = ${id}`
	return row.count
}

test.describe('ui/confirm-dialog', () => {
	test('declining leaves the record alone', async ({ page }) => {
		const prefix = uniquePrefix('confirm-decline')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const projectId = await seedProject(prefix)
			await page.goto('/projects')
			await waitForHydration(page)

			const card = page.locator('div.group').filter({ hasText: `${prefix} Project` }).first()
			await expect(card).toBeVisible()
			await card.getByRole('button', { name: 'Delete project' }).click()

			const dialog = page.getByRole('alertdialog')
			await expect(dialog).toBeVisible()
			await expect(dialog).toContainText('This cannot be undone.')

			await answerConfirmDialog(page, 'Delete', { decline: true })

			// The point of the test: declining is not merely a dismissed dialog, it aborts.
			await expect(card).toBeVisible()
			expect(await projectCount(projectId), 'declining must not delete').toBe(1)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('Escape declines', async ({ page }) => {
		const prefix = uniquePrefix('confirm-escape')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const projectId = await seedProject(prefix)
			await page.goto('/projects')
			await waitForHydration(page)

			await page
				.locator('div.group')
				.filter({ hasText: `${prefix} Project` })
				.first()
				.getByRole('button', { name: 'Delete project' })
				.click()

			const dialog = page.getByRole('alertdialog')
			await expect(dialog).toBeVisible()
			await page.keyboard.press('Escape')
			await expect(dialog).toBeHidden()

			expect(await projectCount(projectId), 'Escape must not delete').toBe(1)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('confirming performs the action', async ({ page }) => {
		const prefix = uniquePrefix('confirm-accept')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const projectId = await seedProject(prefix)
			await page.goto('/projects')
			await waitForHydration(page)

			await page
				.locator('div.group')
				.filter({ hasText: `${prefix} Project` })
				.first()
				.getByRole('button', { name: 'Delete project' })
				.click()

			await answerConfirmDialog(page, 'Delete')

			await expect
				.poll(async () => projectCount(projectId), { timeout: 15_000 })
				.toBe(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
