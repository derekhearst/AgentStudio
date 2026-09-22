import { expect, test } from '@playwright/test'
import { authenticateContext } from './helpers'

test('memory palace page renders for authenticated user', async ({ page }) => {
	await authenticateContext(page.context())
	await page.goto('/memory')
	await expect(page.getByRole('heading', { name: /memory palace/i })).toBeVisible()
	// "Search memories", not "search memory" — the old regex missed by one character.
	await expect(page.getByPlaceholder(/^search memories/i)).toBeVisible()
	await expect(page.getByRole('button', { name: 'Search' })).toBeVisible()
	// The four-column Wings/Rooms/Closets/Drawers layout this used to assert on is gone;
	// the palace is a map with a list fallback now, and the counts live in header chips.
	// Assert the page actually rendered its body rather than a spinner or an error.
	await expect(page.getByRole('button', { name: /how it works/i })).toBeVisible()
	await expect(page.locator('.memory-page__body')).toBeVisible()
})

test('memory settings section shows toggles', async ({ page }) => {
	await authenticateContext(page.context())
	await page.goto('/settings')
	// The settings nav lists the section and the panel heads it; both match.
	await expect(page.getByRole('heading', { name: 'Memory Palace' })).toBeVisible()
	await expect(page.getByText(/Enable memory recall/i)).toBeVisible()
	await expect(page.getByText(/Auto-mine conversations/i)).toBeVisible()
})
