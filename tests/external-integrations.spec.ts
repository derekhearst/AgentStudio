import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	expectRealAssistantReply,
	getSql,
	seedConversation,
	uniquePrefix,
} from './helpers'

test('streams and persists a real assistant response from chat UI', async ({ page }) => {
	const prefix = uniquePrefix('ext-chat')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		const conversation = await seedConversation(prefix)
		await page.goto(`/chat/${conversation.id}`)
		await page.waitForLoadState('networkidle')

		await page.getByPlaceholder('Message AgentStudio...').fill(`${prefix} hello stream`)
		await page
			.getByRole('button', { name: /send message/i })
			.first()
			.click()

		const content = await expectRealAssistantReply(conversation.id)
		expect(content.length).toBeGreaterThan(8)
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
