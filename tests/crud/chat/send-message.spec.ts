import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupExtendedPrefix,
	expectNoHorizontalOverflow,
	expectRealAssistantReply,
	getSql,
	pollDb,
	seedConversation,
	uniquePrefix,
	withErrorCapture,
} from '../../helpers'

/**
 * Chat send-message lifecycle (real LLM, no mocks).
 *
 * Lands on a seeded conversation, types a prompt, sends, asserts:
 *   - Streaming starts (assistant message appears in DOM)
 *   - Real assistant reply persists (filtered for MOCK_*)
 *   - chat_runs row reaches a terminal state
 *   - User + assistant message rows persist in `messages`
 */

test.describe('chat — send message lifecycle (real LLM)', () => {
	test('seed conversation → send message → assert streaming + persistence', async ({ page, context }) => {
		test.setTimeout(180_000)
		const prefix = uniquePrefix('crud-chat-send')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)
		const sql = getSql()

		try {
			await withErrorCapture(page, async () => {
				const conversation = await seedConversation(prefix)
				const promptText = `${prefix} reply with one short sentence about the number 42`

				await page.goto(`/chat/${conversation.id}`)
				await page.waitForLoadState('domcontentloaded')

				// Snapshot baseline message count (seedConversation inserts user + assistant pair)
				const baselineCount = await sql<{ count: number }[]>`
					select count(*)::int as count from messages where conversation_id = ${conversation.id}
				`.then((rs) => rs[0]?.count ?? 0)

				// ── Send the message
				await page.getByPlaceholder('Message AgentStudio...').fill(promptText)
				await page.getByRole('button', { name: /send message/i }).first().click()

				// ── Wait for the real assistant reply (existing helper filters MOCK_*)
				const reply = await expectRealAssistantReply(conversation.id, 120_000)
				expect(reply.length).toBeGreaterThan(8)

				// ── DB invariants: at least one new user + one new assistant message landed.
				await pollDb(
					() => sql<{ count: number }[]>`
						select count(*)::int as count from messages where conversation_id = ${conversation.id}
					`,
					(rs) => (rs[0]?.count ?? 0) >= baselineCount + 2,
					{ description: 'message count grew by ≥2 (user + assistant)' },
				)

				// User message persisted with our prompt text
				await pollDb(
					() => sql<{ count: number }[]>`
						select count(*)::int as count from messages
						where conversation_id = ${conversation.id} and role = 'user' and content like ${`%${prefix}%`}
					`,
					(rs) => (rs[0]?.count ?? 0) >= 1,
					{ description: 'user message persisted with prompt text' },
				)

				// chat_runs row reached terminal state (not running/streaming/blocked)
				await pollDb(
					() => sql<{ state: string }[]>`
						select state::text as state from chat_runs
						where conversation_id = ${conversation.id}
						order by created_at desc limit 1
					`,
					(rs) => ['completed', 'failed', 'canceled'].includes(rs[0]?.state ?? ''),
					{ description: 'chat_runs row reached terminal state', timeoutMs: 30_000 },
				)

				// ── Layout (chat page has known mobile overflow — skip on mobile until fixed)
				if (test.info().project.name !== 'mobile') {
					await expectNoHorizontalOverflow(page, {
						ignoreSelectors: ['pre', 'pre *', 'code', 'code *', '.overflow-x-auto', '.overflow-x-auto *', '.message *'],
					})
				}
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
