import { expect, test } from '@playwright/test'
import { authenticateContext, getSql } from './helpers'

/**
 * #70 — the new-chat greeting named "Derek" for everyone. It now uses the display name the
 * owner gave in /setup, and says nothing after the greeting when there is none.
 */
test('the new-chat greeting uses the owner’s display name (#70)', async ({ page }) => {
	test.setTimeout(60_000)
	await authenticateContext(page.context())
	const [owner] = await getSql()<{ name: string | null }[]>`select name from users limit 1`
	const name = owner?.name?.trim() ?? ''

	await page.goto('/', { waitUntil: 'domcontentloaded' })
	const expected = name ? `, ${name}` : ''
	await expect(page.getByRole('heading', { level: 2 }).filter({ hasText: /^Good (morning|afternoon|evening)/ }).first()).toHaveText(
		new RegExp(`^Good (morning|afternoon|evening)${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
	)
})
