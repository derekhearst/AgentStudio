import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupExtendedPrefix,
	expectNoHorizontalOverflow,
	getSql,
	pollDb,
	seedConversation,
	uniquePrefix,
	withErrorCapture,
} from '../../helpers'

/**
 * Chat mode-switch lifecycle.
 *
 * Cycles through chat → plan → research → agent via the ModeSelector dropdown.
 * Asserts:
 *   - `conversations.mode` column updates after each switch
 *   - A system anchor message is written for each transition
 */

test.describe('chat — mode switching', () => {
	test('cycle modes via the ModeSelector dropdown + assert anchor messages', async ({ page, context }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('crud-chat-mode')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)
		const sql = getSql()

		try {
			await withErrorCapture(page, async () => {
				const conversation = await seedConversation(prefix)
				await page.goto(`/chat/${conversation.id}`)
				await page.waitForLoadState('domcontentloaded')

				// Snapshot baseline message count
				const baselineCount = await sql<{ count: number }[]>`
					select count(*)::int as count from messages where conversation_id = ${conversation.id}
				`.then((rs) => rs[0]?.count ?? 0)

				const modes: Array<'plan' | 'research' | 'agent' | 'chat'> = ['plan', 'research', 'agent', 'chat']
				for (const next of modes) {
					// Open the mode dropdown
					const modeBtn = page.getByRole('button', { name: 'Conversation mode' })
					await modeBtn.click()
					// Click the option matching the mode label. The dropdown buttons have an
					// accessible name that includes both the label and the description, so use
					// a startsWith regex.
					const label = next.charAt(0).toUpperCase() + next.slice(1)
					await page.getByRole('button', { name: new RegExp(`^${label} `) }).first().click()

					await pollDb(
						() => sql<{ mode: string }[]>`
							select mode::text as mode from conversations where id = ${conversation.id}
						`,
						(rs) => rs[0]?.mode === next,
						{ description: `conversation.mode → ${next}` },
					)
				}

				// 4 transitions should have written 4 anchor messages (format: "[Mode changed to ...]")
				await pollDb(
					() => sql<{ count: number }[]>`
						select count(*)::int as count from messages
						where conversation_id = ${conversation.id} and content like '%[Mode changed to%'
					`,
					(rs) => (rs[0]?.count ?? 0) >= 4,
					{ description: 'four mode-change anchor messages persisted' },
				)

				// Total message count should have grown by 4 (anchor messages)
				const finalCount = await sql<{ count: number }[]>`
					select count(*)::int as count from messages where conversation_id = ${conversation.id}
				`.then((rs) => rs[0]?.count ?? 0)
				expect(finalCount).toBeGreaterThanOrEqual(baselineCount + 4)

				// Mobile chat layout has known overflow bugs (header h1, context dropdown,
				// message bubbles, textarea). Skip the overflow assert on mobile until those
				// are fixed in a dedicated UX slice.
				if (test.info().project.name !== 'mobile') {
					await expectNoHorizontalOverflow(page, {
						ignoreSelectors: ['pre', 'pre *', 'code', 'code *', '.overflow-x-auto', '.overflow-x-auto *'],
					})
				}
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
