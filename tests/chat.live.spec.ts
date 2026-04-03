import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, readEnvVar, uniquePrefix } from './helpers'

test.describe('@live chat', () => {
	test.skip(process.env.PLAYWRIGHT_LIVE !== '1', 'Set PLAYWRIGHT_LIVE=1 to run live-provider chat tests')
	test.skip(!readEnvVar('OPENROUTER_API_KEY'), 'OPENROUTER_API_KEY is required for live chat tests')

	test('streams and persists a non-mock assistant response', async ({ page }) => {
		const prefix = uniquePrefix('live-chat')
		const title = `${prefix} Conversation`
		const prompt = `${prefix} Please answer in one short sentence about SvelteKit.`

		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			await page.goto('/chat')
			await page.getByPlaceholder('Conversation title').fill(title)
			await page.getByRole('button', { name: /create/i }).click()
			await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/)

			await page.getByPlaceholder('Message DrokBot...').fill(prompt)
			await page
				.locator('main')
				.getByRole('button', { name: /^send$/i })
				.first()
				.click()

			const conversationId = page.url().split('/').pop()
			expect(conversationId).toBeTruthy()

			const sql = getSql()
			await expect
				.poll(
					async () => {
						const rows = await sql<{ content: string }[]>`
						select content
						from messages
						where conversation_id = ${conversationId ?? ''} and role = 'assistant'
						order by created_at desc
						limit 1
					`
						return rows[0]?.content ?? ''
					},
					{ timeout: 60000 },
				)
				.not.toEqual('')

			const rows = await sql<{ content: string }[]>`
				select content
				from messages
				where conversation_id = ${conversationId ?? ''} and role = 'assistant'
				order by created_at desc
				limit 1
			`
			const content = rows[0]?.content ?? ''
			expect(content).not.toContain('MOCK_STREAM:')
			expect(content).not.toContain('MOCK_RESPONSE:')
			expect(content.length).toBeGreaterThan(8)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
