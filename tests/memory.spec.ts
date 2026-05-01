import { expect, test } from '@playwright/test'
import { authenticateContext } from './helpers'

test('memory palace page renders for authenticated user', async ({ page }) => {
	await authenticateContext(page.context())
	await page.goto('/memory')
	await expect(page.getByRole('heading', { name: /memory palace/i })).toBeVisible()
	await expect(page.getByPlaceholder(/search memory/i)).toBeVisible()
	// All four columns
	for (const label of ['Wings', 'Rooms', 'Closets', 'Drawers']) {
		await expect(page.getByRole('heading', { name: label })).toBeVisible()
	}
})

test('memory settings section shows toggles', async ({ page }) => {
	await authenticateContext(page.context())
	await page.goto('/settings')
	await expect(page.getByText(/Memory Palace/i)).toBeVisible()
	await expect(page.getByText(/Enable memory recall/i)).toBeVisible()
	await expect(page.getByText(/Auto-mine conversations/i)).toBeVisible()
})
