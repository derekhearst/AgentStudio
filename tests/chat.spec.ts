import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, seedConversation, uniquePrefix } from './helpers'

test('creates and opens a conversation from the chat index', async ({ page }) => {
	const prefix = uniquePrefix('chat')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	let conversationId: string | null = null
	const sql = getSql()

	try {
		await page.goto('/chat')
		await page.waitForLoadState('networkidle')
		const newChatBtn = page.getByRole('button', { name: /\+ new chat/i })
		await newChatBtn.waitFor({ state: 'visible' })
		await newChatBtn.click()

		await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/, { timeout: 10000 })
		conversationId = page.url().split('/').pop() ?? null

		// Verify the conversation exists in DB
		await expect
			.poll(async () => {
				if (!conversationId) return 0
				const rows = await sql<
					{ count: string }[]
				>`select count(*)::text as count from conversations where id = ${conversationId}`
				return Number(rows[0]?.count ?? 0)
			})
			.toBe(1)
	} finally {
		if (conversationId) {
			await sql`delete from messages where conversation_id = ${conversationId}`
			await sql`delete from conversations where id = ${conversationId}`
		}
		await cleanupPrefixedRecords(prefix)
	}
})

test('shows conversation detail timeline and composer for seeded data', async ({ page }) => {
	const prefix = uniquePrefix('chat-detail')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		const conversation = await seedConversation(prefix)
		await page.goto(`/chat/${conversation.id}`)

		await expect(page.getByRole('heading', { name: conversation.title })).toBeVisible()
		await expect(page.getByText(/model:/i)).toBeVisible()
		await expect(page.getByPlaceholder('Message DrokBot...')).toBeVisible()
		await expect(page.locator('main').getByRole('button', { name: /send/i }).first()).toBeDisabled()
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
