import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, seedMemory, uniquePrefix } from './helpers'

test('searches, pins, views, updates, and deletes a memory', async ({ page }) => {
	const prefix = uniquePrefix('memory')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		const memory = await seedMemory(prefix, { content: `${prefix} memory content` })

		await page.goto('/memory')
		await page.getByPlaceholder('Search memories').fill(prefix)
		await page.getByRole('button', { name: /apply/i }).click()
		await expect(page.getByText(memory.content)).toBeVisible()

		const card = page.locator('article').filter({ hasText: memory.content })
		await card.getByRole('button', { name: /^pin$/i }).click()
		const sql = getSql()
		await expect
			.poll(async () => {
				const rows = await sql<{ category: string }[]>`select category from memories where id = ${memory.id}`
				return rows[0]?.category ?? ''
			})
			.toContain('pinned')

		await page.goto(`/memory/${memory.id}`)
		await expect(page.getByRole('heading', { name: /memory detail/i })).toBeVisible()
		await expect(page.getByText(memory.content)).toBeVisible()

		page.once('dialog', (dialog) => dialog.accept('1'))
		await page.getByRole('button', { name: /edit importance/i }).click()
		await expect
			.poll(async () => {
				const rows = await sql<{ importance: number }[]>`select importance from memories where id = ${memory.id}`
				return Number(rows[0]?.importance ?? 0)
			})
			.toBeCloseTo(1, 5)

		await page.getByRole('button', { name: /^delete$/i }).click()
		await expect(page).toHaveURL(/\/memory$/)
		await expect(page.getByText(memory.content)).toHaveCount(0)
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
