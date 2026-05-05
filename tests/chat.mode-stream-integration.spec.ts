import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #22 P7 — chat-stream integration with conversation mode.
 *
 * The pure tool-filter unit tests pin the contract (`mode-filter.ts`); these tests
 * verify the actual chat detail page reflects the mode-aware UI surface end-to-end:
 *   - Mode anchor message persists on switch (covers the existing setConversationMode
 *     path; complements chat.mode-selector.spec.ts)
 *   - The composer's mode label updates after a switch
 *   - The mode posture skill is non-empty when set to research (data-layer assertion;
 *     the prompt slot is invisible to the user but provable through the seeded skill)
 */

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

async function seedConversation(prefix: string, userId: string, overrides?: { mode?: 'chat' | 'research' | 'plan' | 'agent' }) {
	const sql = getSql()
	const mode = overrides?.mode ?? 'chat'
	const [row] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost, mode)
		values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0', ${mode}::chat_mode)
		returning id
	`
	return row
}

test.describe('chat/mode-stream-integration — research mode posture', () => {
	test('research-mode conversation reads the seeded mode-identity skill content', async () => {
		// The mode-identity skills are seeded at boot with fixed UUIDs. This test pins
		// that the research skill exists with non-empty content — the chat-stream slot
		// pipeline picks this up via getModePostureContent → loadModeIdentitySkill.
		const sql = getSql()
		const RESEARCH_SKILL_ID = '00000000-0000-4000-8000-00000000c002'
		const [skill] = await sql<{ id: string; name: string; content: string; enabled: boolean }[]>`
			select id, name, content, enabled from skills where id = ${RESEARCH_SKILL_ID}
		`
		test.skip(!skill, 'Research mode-identity skill not yet seeded — restart dev server')
		expect(skill.name).toBe('system/mode-research')
		expect(skill.enabled).toBe(true)
		expect(skill.content).toMatch(/Research/)
		expect(skill.content.length).toBeGreaterThan(80)
	})

	test('switching a conversation to research mode persists + writes anchor message', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('mode-research-switch')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()
		const sql = getSql()

		try {
			const conv = await seedConversation(prefix, userId)
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })

			const modeButton = page.getByRole('button', { name: /Conversation mode/ }).first()
			await modeButton.waitFor({ state: 'visible', timeout: 30_000 })
			await modeButton.click()
			const menu = page.locator('ul.dropdown-content').first()
			await menu.waitFor({ state: 'visible', timeout: 5_000 })

			const switchResponse = page.waitForResponse(
				(r) => r.url().includes('setConversationMode') && r.status() === 200,
				{ timeout: 10_000 },
			)
			await menu.getByRole('button', { name: /^Research/ }).click()
			await switchResponse

			// DB reflects the change.
			const [row] = await sql<{ mode: string }[]>`
				select mode::text as mode from conversations where id = ${conv.id}
			`
			expect(row.mode).toBe('research')

			// Mode label updates in the UI.
			await expect(modeButton).toContainText('Research', { timeout: 15_000 })

			// Anchor message exists with the right metadata for the model's posture
			// memory after compaction.
			const sysRows = await sql<{ content: string; metadata: Record<string, unknown> }[]>`
				select content, metadata from messages
				where conversation_id = ${conv.id} and role = 'system'
			`
			const anchor = sysRows.find((m) => (m.metadata as { type?: string }).type === 'mode_anchor')
			expect(anchor).toBeDefined()
			expect((anchor!.metadata as { mode?: string }).mode).toBe('research')
			expect(anchor!.content).toMatch(/Research/i)
		} finally {
			await sql`delete from messages where conversation_id in (select id from conversations where title like ${`${prefix}%`})`
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('chat/mode-stream-integration — research mode tool surface (pure data check)', () => {
	test('the read-only allow-list strips push_branch, create_pull_request, clone_repository', async () => {
		// Pure unit-style assertion at the data layer — verifies the allow-list shape so
		// a future PR that adds a write-tool to source-control without auditing the mode
		// filter trips this test instead of silently leaking the tool to research mode.
		const { getReadOnlyToolNames, isToolAllowedInMode } = await import('../src/lib/chat/mode-filter')
		const readOnly = new Set(getReadOnlyToolNames())
		const writeTools = ['push_branch', 'create_pull_request', 'clone_repository', 'shell', 'file_write']
		for (const tool of writeTools) {
			expect(readOnly.has(tool), `${tool} must NOT be in the read-only set`).toBe(false)
			expect(isToolAllowedInMode(tool, 'research'), `${tool} must be blocked in research mode`).toBe(false)
			expect(isToolAllowedInMode(tool, 'plan'), `${tool} must be blocked in plan mode`).toBe(false)
		}
		// Read-only source-control tools must remain available.
		const readOnlySC = ['list_my_repos', 'prepare_commit', 'list_pull_requests', 'get_pull_request']
		for (const tool of readOnlySC) {
			expect(readOnly.has(tool), `${tool} must be in the read-only set`).toBe(true)
			expect(isToolAllowedInMode(tool, 'research')).toBe(true)
		}
	})
})
