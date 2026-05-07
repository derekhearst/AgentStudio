import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * Composer agent dropdown writes through to DB (replaces the prior `chat.mode-selector` spec
 * after the modes-into-agents unification).
 */

const PLAN_AGENT_ID = '00000000-0000-4000-8000-0000000a6e73'

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

async function seedConversation(prefix: string, userId: string, agentId: string | null = null) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, agent_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, ${agentId}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id
	`
	return row
}

test.describe('chat/agent-selector — composer agent dropdown writes through to DB', () => {
	test('selecting Plan persists conversation.agent_id and inserts a system anchor message', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('chat-agent-selector')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			// Bind to Chat builtin first so the picker has a known starting selection.
			const [chatBuiltin] = await sql<{ id: string }[]>`select id from agents where builtin_key = 'chat' limit 1`
			const conv = await seedConversation(prefix, userId, chatBuiltin?.id ?? null)
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })

			const agentButton = page
				.getByRole('button', { name: /Conversation agent/ })
				.first()
			await agentButton.waitFor({ state: 'visible', timeout: 30_000 })
			await expect(agentButton).toContainText('Chat')

			await agentButton.click()
			const menu = page.locator('ul.dropdown-content').first()
			await menu.waitFor({ state: 'visible', timeout: 5_000 })
			const planResponse = page.waitForResponse(
				(r) => r.url().includes('setConversationAgent') && r.status() === 200,
				{ timeout: 10_000 },
			)
			await menu.getByRole('button', { name: /^Plan/ }).click()
			await planResponse

			const [row] = await sql<{ agent_id: string }[]>`
				select agent_id::text as agent_id from conversations where id = ${conv.id}
			`
			expect(row.agent_id).toBe(PLAN_AGENT_ID)

			await expect(agentButton).toContainText('Plan', { timeout: 15_000 })

			const sysRows = await sql<{ content: string; metadata: Record<string, unknown> }[]>`
				select content, metadata from messages
				where conversation_id = ${conv.id} and role = 'system'
				order by created_at desc
			`
			const anchor = sysRows.find((m) => (m.metadata as { type?: string }).type === 'agent_anchor')
			expect(anchor, 'agent switch must persist an anchor message').toBeDefined()
			expect(anchor!.content).toContain('Plan')
			expect((anchor!.metadata as { agentId?: string }).agentId).toBe(PLAN_AGENT_ID)
			expect((anchor!.metadata as { previousAgentId?: string }).previousAgentId).toBe(chatBuiltin?.id)
		} finally {
			await sql`delete from messages where conversation_id in (select id from conversations where title like ${`${prefix}%`})`
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('selecting the same agent is a no-op (no extra anchor message)', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('chat-agent-selector-noop')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [chatBuiltin] = await sql<{ id: string }[]>`select id from agents where builtin_key = 'chat' limit 1`
			const conv = await seedConversation(prefix, userId, chatBuiltin?.id ?? null)
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })

			const agentButton = page
				.getByRole('button', { name: /Conversation agent/ })
				.first()
			await agentButton.waitFor({ state: 'visible', timeout: 30_000 })
			await agentButton.click()
			const menu = page.locator('ul.dropdown-content').first()
			await menu.waitFor({ state: 'visible', timeout: 5_000 })
			await menu.getByRole('button', { name: /^Chat/ }).click()

			const sysRows = await sql<{ id: string; metadata: Record<string, unknown> }[]>`
				select id, metadata from messages
				where conversation_id = ${conv.id} and role = 'system'
			`
			const anchors = sysRows.filter((m) => (m.metadata as { type?: string }).type === 'agent_anchor')
			expect(anchors.length, 'no anchor message should be written when the agent is unchanged').toBe(0)
		} finally {
			await sql`delete from messages where conversation_id in (select id from conversations where title like ${`${prefix}%`})`
			await cleanupPrefixedRecords(prefix)
		}
	})
})
