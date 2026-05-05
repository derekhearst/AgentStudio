import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, seedConversation, uniquePrefix } from './helpers'

test('typing in the home composer + clicking send creates a conversation and navigates to it', async ({ page }) => {
	const prefix = uniquePrefix('chat')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	let conversationId: string | null = null
	const sql = getSql()

	try {
		await page.goto('/', { waitUntil: 'domcontentloaded' })

		// Home composer textarea + Send button (the "+ new chat" button no longer exists).
		const composer = page.getByPlaceholder('Start a new conversation...').first()
		await composer.waitFor({ state: 'visible', timeout: 15_000 })
		await composer.fill(`${prefix} smoke message`)

		const sendBtn = page.getByRole('button', { name: /^Send message$/i }).first()
		await sendBtn.click()

		// URL changes to /chat/<uuid>?prompt=…
		await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+(\?|$)/, { timeout: 10000 })
		const match = page.url().match(/\/chat\/([0-9a-f-]+)/)
		conversationId = match?.[1] ?? null

		await expect
			.poll(async () => {
				if (!conversationId) return 0
				const rows = await sql<{ count: string }[]>`
					select count(*)::text as count from conversations where id = ${conversationId}
				`
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

test('chat detail page shows the conversation title and the message composer for seeded data', async ({ page }) => {
	const prefix = uniquePrefix('chat-detail')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		const conversation = await seedConversation(prefix)
		await page.goto(`/chat/${conversation.id}`, { waitUntil: 'domcontentloaded' })

		// Wait for the conversation to hydrate. Use the user message bubble — guaranteed visible
		// on both desktop and mobile (the h1 with the conversation title is desktop:hidden since
		// the desktop layout shows the title in the recent-chats sidebar instead).
		await expect(page.getByText(`${prefix} user message`, { exact: true })).toBeVisible({ timeout: 15_000 })

		// Document title carries the conversation title — covers desktop + mobile.
		await expect(page).toHaveTitle(new RegExp(`^${conversation.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| AgentStudio$`))

		// Composer + Send button render. Send is disabled while the textarea is empty.
		await expect(page.getByPlaceholder('Message AgentStudio...').first()).toBeVisible()
		await expect(page.getByRole('button', { name: /^Send message$/i }).first()).toBeDisabled()
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
