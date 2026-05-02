import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, seedConversation, uniquePrefix } from './helpers'

test('wave0 smoke routes load for authenticated user', async ({ page }) => {
	await authenticateContext(page.context())

	for (const path of ['/chat', '/agents', '/settings']) {
		const response = await page.goto(path, { waitUntil: 'domcontentloaded' })
		expect(response?.ok(), `${path} should load successfully`).toBeTruthy()
		await expect(page.locator('body')).not.toContainText(/Internal Server Error|Cannot import/)
	}
})

test('wave0 smoke chat detail route loads for seeded conversation', async ({ page }) => {
	const prefix = uniquePrefix('wave0-smoke-chat-detail')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		const conversation = await seedConversation(prefix)
		const response = await page.goto(`/chat/${conversation.id}`, { waitUntil: 'domcontentloaded' })
		expect(response?.ok(), 'chat detail should load successfully').toBeTruthy()
		await expect(page).toHaveURL(new RegExp(`/chat/${conversation.id}$`))
		await expect(page.locator('body')).not.toContainText(/Internal Server Error|Cannot import/)
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
