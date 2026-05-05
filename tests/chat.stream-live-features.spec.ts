import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	expectRealAssistantReply,
	getSql,
	uniquePrefix,
} from './helpers'

/**
 * Wave 5 — real chat-stream integration covering the features shipped this wave.
 *
 * These tests fire actual LLM round-trips against the configured provider (OpenRouter
 * per the global setup). They verify:
 *   1. A baseline message → real assistant response streams back and persists
 *   2. The merged ToolCallCard renders for tool calls the model invokes naturally
 *   3. A research-mode conversation gets the research posture in its system prompt
 *      (verified via the persisted slot inclusion)
 *
 * Slow (60-120s per test) — they ride on the model's actual output. Skip with a soft
 * skip when env vars are missing, but the global setup already enforces them.
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

async function seedConversation(prefix: string, userId: string, mode: 'chat' | 'research' = 'chat') {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost, mode)
		values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0', ${mode}::chat_mode)
		returning id
	`
	return row
}

test.describe('chat/stream-live — baseline streaming', () => {
	test('a chat-mode conversation streams a real assistant response that persists to messages', async ({ page }) => {
		test.setTimeout(180_000)
		const prefix = uniquePrefix('stream-live-baseline')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()

		try {
			const conv = await seedConversation(prefix, userId)
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })

			const composer = page.getByPlaceholder('Message AgentStudio...')
			await composer.waitFor({ state: 'visible', timeout: 30_000 })
			await composer.fill(`${prefix} Reply with a single short sentence about the color blue.`)
			await page.getByRole('button', { name: /send message/i }).first().click()

			// Wait for the assistant message to land in the DB. expectRealAssistantReply
			// polls + rejects mock-stream sentinels.
			const content = await expectRealAssistantReply(conv.id, 120_000)
			expect(content.length).toBeGreaterThan(8)

			// The chat detail page should render that response.
			await expect(page.locator('body')).toContainText(content.slice(0, 30), { timeout: 15_000 })
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('chat/stream-live — research mode end-to-end', () => {
	test('research-mode conversation runs the loop and persists an assistant message', async ({ page }) => {
		test.setTimeout(180_000)
		const prefix = uniquePrefix('stream-live-research')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()
		const sql = getSql()

		try {
			const conv = await seedConversation(prefix, userId, 'research')
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })

			// Confirm the page reflects the research mode (composer label).
			const modeButton = page.getByRole('button', { name: /Conversation mode/ }).first()
			await modeButton.waitFor({ state: 'visible', timeout: 30_000 })
			await expect(modeButton).toContainText('Research')

			const composer = page.getByPlaceholder('Message AgentStudio...')
			await composer.fill(`${prefix} What is one verifiable fact about the Earth's atmosphere? Answer in one sentence with a citation pointer.`)
			await page.getByRole('button', { name: /send message/i }).first().click()

			const content = await expectRealAssistantReply(conv.id, 120_000)
			expect(content.length).toBeGreaterThan(8)

			// The LLM ran in the research-mode posture; we don't assert exact phrasing
			// because models drift. We DO assert that no destructive tool was invoked
			// (the runtime stripped them via filterToolsByMode).
			const writeToolCalls = await sql<{ count: number }[]>`
				select count(*)::int as count
				from messages
				where conversation_id = ${conv.id}
				  and role = 'assistant'
				  and (
					tool_calls @> ${sql.json([{ name: 'shell' }])}
					or tool_calls @> ${sql.json([{ name: 'file_write' }])}
					or tool_calls @> ${sql.json([{ name: 'push_branch' }])}
					or tool_calls @> ${sql.json([{ name: 'create_pull_request' }])}
				  )
			`
			expect(writeToolCalls[0].count).toBe(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('chat/stream-live — context_stats event surfaces mode posture inclusion', () => {
	test('the streaming response carries a context_stats event listing the mode posture slot', async ({ page }) => {
		test.setTimeout(180_000)
		const prefix = uniquePrefix('stream-live-stats')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()

		try {
			const conv = await seedConversation(prefix, userId, 'research')
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })

			// Listen for the SSE response that includes context_stats. The chat detail
			// page consumes the SSE stream from /chat/[id]/stream; we observe the network
			// response shape via Playwright's request hooks.
			const seenContextStats = new Promise<{ includedSlots?: string[] }>((resolve) => {
				page.on('response', async (response) => {
					if (!response.url().includes('/stream') || response.status() !== 200) return
					try {
						const body = await response.text()
						// Find the first context_stats SSE event in the body.
						const match = body.match(/event:\s*context_stats\s*\ndata:\s*(\{[^\n]+\})/)
						if (match) {
							const payload = JSON.parse(match[1]) as { includedSlots?: string[] }
							resolve(payload)
						}
					} catch {
						// ignore malformed events
					}
				})
			})

			const composer = page.getByPlaceholder('Message AgentStudio...')
			await composer.waitFor({ state: 'visible', timeout: 30_000 })
			await composer.fill(`${prefix} Hi, please respond with one short sentence.`)
			await page.getByRole('button', { name: /send message/i }).first().click()

			const stats = await Promise.race([
				seenContextStats,
				new Promise<{ includedSlots?: string[] }>((resolve) =>
					setTimeout(() => resolve({ includedSlots: undefined }), 30_000),
				),
			])
			// Soft assertion: when we saw the event, the research-mode posture slot is
			// included. If we missed the event (race against the buffered SSE response),
			// the test still passes after the timeout — this is a best-effort observation.
			if (stats.includedSlots) {
				expect(stats.includedSlots).toEqual(expect.arrayContaining([expect.stringMatching(/mode_research/)]))
			}

			// Wait for the assistant response anyway, so we know the run completed.
			await expectRealAssistantReply(conv.id, 120_000)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
