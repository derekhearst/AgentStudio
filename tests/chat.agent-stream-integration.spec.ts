import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * Chat-stream integration with the unified agent picker.
 *
 * Verifies:
 *   - The Research built-in agent has a non-empty system_prompt seeded
 *   - Switching the conversation's bound agent persists + writes an `agent_anchor` system
 *     message into history
 *   - The agent.config.toolPolicy on Research/Plan strips destructive tools (data-layer
 *     allow-list audit)
 */

const RESEARCH_AGENT_ID = '00000000-0000-4000-8000-0000000a6e72'

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

test.describe('chat/agent-stream-integration — Research agent posture', () => {
	test('research agent has a non-empty system_prompt seeded', async () => {
		const sql = getSql()
		const [agent] = await sql<{ id: string; name: string; system_prompt: string; identity_skill_id: string | null }[]>`
			select id, name, system_prompt, identity_skill_id::text as identity_skill_id
			from agents where id = ${RESEARCH_AGENT_ID}
		`
		test.skip(!agent, 'Research agent not yet seeded — restart dev server')
		expect(agent.name).toBe('Research')
		expect(agent.identity_skill_id, 'built-in agents must not link to a system/ skill').toBeNull()
		expect(agent.system_prompt).not.toBe('Seeded at boot.')
		expect(agent.system_prompt).toMatch(/Research/)
		expect(agent.system_prompt.length).toBeGreaterThan(80)
	})

	test('switching a conversation to the Research agent persists + writes anchor message', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('agent-research-switch')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()
		const sql = getSql()

		try {
			const conv = await seedConversation(prefix, userId)
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })

			const agentButton = page.getByRole('button', { name: /Conversation agent/ }).first()
			await agentButton.waitFor({ state: 'visible', timeout: 30_000 })
			await agentButton.click()
			const menu = page.locator('ul.dropdown-content').first()
			await menu.waitFor({ state: 'visible', timeout: 5_000 })

			const switchResponse = page.waitForResponse(
				(r) => r.url().includes('setConversationAgent') && r.status() === 200,
				{ timeout: 10_000 },
			)
			await menu.getByRole('button', { name: /^Research/ }).click()
			await switchResponse

			// DB reflects the change.
			const [row] = await sql<{ agent_id: string }[]>`
				select agent_id::text as agent_id from conversations where id = ${conv.id}
			`
			expect(row.agent_id).toBe(RESEARCH_AGENT_ID)

			// Agent label updates in the UI.
			await expect(agentButton).toContainText('Research', { timeout: 15_000 })

			// Anchor message exists with the right metadata for the model's posture
			// memory after compaction.
			const sysRows = await sql<{ content: string; metadata: Record<string, unknown> }[]>`
				select content, metadata from messages
				where conversation_id = ${conv.id} and role = 'system'
			`
			const anchor = sysRows.find((m) => (m.metadata as { type?: string }).type === 'agent_anchor')
			expect(anchor).toBeDefined()
			expect((anchor!.metadata as { agentId?: string }).agentId).toBe(RESEARCH_AGENT_ID)
			expect(anchor!.content).toMatch(/Research/i)
		} finally {
			await sql`delete from messages where conversation_id in (select id from conversations where title like ${`${prefix}%`})`
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('chat/agent-stream-integration — Research toolPolicy audit', () => {
	test('the Research built-in agent strips push_branch, create_pull_request, clone_repository', async () => {
		const sql = getSql()
		const [row] = await sql<{ config: { toolPolicy?: { kind?: string; allow?: string[] } } }[]>`
			select config from agents where id = ${RESEARCH_AGENT_ID}
		`
		const policy = row?.config?.toolPolicy
		expect(policy?.kind).toBe('readOnly')
		const allow = new Set(policy?.allow ?? [])
		const writeTools = ['push_branch', 'create_pull_request', 'clone_repository', 'shell', 'file_write']
		for (const tool of writeTools) {
			expect(allow.has(tool), `${tool} must NOT be in the Research allow-list`).toBe(false)
		}
		// Read-only source-control tools must remain available.
		const readOnlySC = ['list_my_repos', 'prepare_commit', 'list_pull_requests', 'get_pull_request']
		for (const tool of readOnlySC) {
			expect(allow.has(tool), `${tool} must be in the Research allow-list`).toBe(true)
		}
	})
})
