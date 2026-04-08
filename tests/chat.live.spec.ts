import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	expectRealAssistantReply,
	seedConversation,
	uniquePrefix,
} from './helpers'

test.describe('chat provider integration', () => {
	test('streams and persists a non-mock assistant response', async ({ page }) => {
		test.setTimeout(120000)
		const prefix = uniquePrefix('chat-provider')
		const prompt = `${prefix} Please answer in one short sentence about SvelteKit.`

		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const conversation = await seedConversation(prefix)
			await page.goto(`/chat/${conversation.id}`)
			await page.waitForLoadState('networkidle')

			await page.getByPlaceholder('Message AgentStudio...').fill(prompt)
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
})
