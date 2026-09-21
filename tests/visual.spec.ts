import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	seedAgent,
	seedConversation,
	uniquePrefix,
} from './helpers'

test('visual regression: chat index', async ({ page }) => {
	const prefix = uniquePrefix('visual-chat')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		await seedConversation(prefix, { title: `${prefix} conversation` })
		await page.goto('/chat')
		await expect(page.getByRole('heading', { name: /^chats$/i })).toBeVisible()
		await expect(page.getByRole('button', { name: /\+ new chat/i })).toBeVisible()
		await expect(page.getByText(`${prefix} conversation`)).toBeVisible()
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})

test('visual regression: settings page', async ({ page }) => {
	const prefix = uniquePrefix('visual-settings')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		await page.goto('/settings')
		await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible()
		await expect(page.locator('main')).toHaveScreenshot('settings-main.png', {
			animations: 'disabled',
			maxDiffPixelRatio: 0.05,
		})
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
