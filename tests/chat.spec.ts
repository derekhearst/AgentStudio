import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, seedConversation, uniquePrefix } from './helpers'

test('creates and opens a conversation from the chat index', async ({ page }) => {
	const prefix = uniquePrefix('chat')
	const title = `${prefix} Conversation`
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		await page.goto('/chat')
		await page.getByPlaceholder('Conversation title').fill(title)
		await page.getByRole('button', { name: /create/i }).click()

		await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/)
		await expect(page.getByRole('heading', { name: title })).toBeVisible()
		const sql = getSql()
		await expect
			.poll(async () => {
				const rows = await sql<
					{ count: string }[]
				>`select count(*)::text as count from conversations where title = ${title}`
				return Number(rows[0]?.count ?? 0)
			})
			.toBe(1)
	} finally {
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
		await expect(page.getByText(/timeline/i)).toBeVisible()
		await expect(page.getByText(/model:/i)).toBeVisible()
		await expect(page.getByPlaceholder('Message DrokBot...')).toBeVisible()
		await expect(page.locator('main').getByRole('button', { name: /send/i }).first()).toBeDisabled()
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
