import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

async function seedConversation(prefix: string, userId: string) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id
	`
	return row
}

test.describe('chat/mode-selector — composer mode dropdown writes through to DB', () => {
	test('selecting Plan persists conversation.mode and inserts a system anchor message', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('chat-mode-selector')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const conv = await seedConversation(prefix, userId)
			// Warm-up navigation so the dep optimizer is ready before the chat detail page.
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })

			// Wait for the composer's mode button to appear (default label is 'Chat').
			const modeButton = page
				.getByRole('button', { name: /Conversation mode/ })
				.first()
			await modeButton.waitFor({ state: 'visible', timeout: 30_000 })
			await expect(modeButton).toContainText('Chat')

			// Open the dropdown, then click the Plan menu item scoped to the dropdown content.
			await modeButton.click()
			const menu = page.locator('ul.dropdown-content').first()
			await menu.waitFor({ state: 'visible', timeout: 5_000 })
			const planResponse = page.waitForResponse(
				(r) => r.url().includes('setConversationMode') && r.status() === 200,
				{ timeout: 10_000 },
			)
			await menu.getByRole('button', { name: /^Plan/ }).click()
			await planResponse

			// DB should reflect the change immediately after the response.
			const [row] = await sql<{ mode: string }[]>`select mode from conversations where id = ${conv.id}`
			expect(row.mode).toBe('plan')

			// The mode label re-renders after the page reloads conversation state.
			await expect(modeButton).toContainText('Plan', { timeout: 15_000 })

			// An anchor system message tagged mode_anchor should have been inserted.
			const sysRows = await sql<{ content: string; metadata: Record<string, unknown> }[]>`
				select content, metadata from messages
				where conversation_id = ${conv.id} and role = 'system'
				order by created_at desc
			`
			const anchor = sysRows.find((m) => (m.metadata as { type?: string }).type === 'mode_anchor')
			expect(anchor, 'mode switch must persist an anchor message').toBeDefined()
			expect(anchor!.content).toContain('Plan')
			expect((anchor!.metadata as { previousMode?: string }).previousMode).toBe('chat')
			expect((anchor!.metadata as { mode?: string }).mode).toBe('plan')
		} finally {
			await sql`delete from messages where conversation_id in (select id from conversations where title like ${`${prefix}%`})`
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('selecting the same mode is a no-op (no extra anchor message)', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('chat-mode-selector-noop')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const conv = await seedConversation(prefix, userId)
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })

			const modeButton = page
				.getByRole('button', { name: /Conversation mode/ })
				.first()
			await modeButton.waitFor({ state: 'visible', timeout: 30_000 })
			await modeButton.click()
			const menu = page.locator('ul.dropdown-content').first()
			await menu.waitFor({ state: 'visible', timeout: 5_000 })
			await menu.getByRole('button', { name: /^Chat/ }).click()

			const sysRows = await sql<{ id: string; metadata: Record<string, unknown> }[]>`
				select id, metadata from messages
				where conversation_id = ${conv.id} and role = 'system'
			`
			const anchors = sysRows.filter((m) => (m.metadata as { type?: string }).type === 'mode_anchor')
			expect(anchors.length, 'no anchor message should be written when mode is unchanged').toBe(0)
		} finally {
			await sql`delete from messages where conversation_id in (select id from conversations where title like ${`${prefix}%`})`
			await cleanupPrefixedRecords(prefix)
		}
	})
})
