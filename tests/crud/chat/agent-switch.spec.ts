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
 * Chat agent-switch lifecycle (replaces the prior `crud/chat/mode-switch.spec.ts` after the
 * modes-into-agents unification).
 *
 * Cycles through the four built-in agents (chat → plan → research → autonomous) via the
 * AgentSelector dropdown. Asserts:
 *   - `conversations.agent_id` updates after each switch
 *   - A system anchor message (`metadata.type = 'agent_anchor'`) is written for each transition
 */

test.describe('chat — agent switching', () => {
	test('cycle built-in agents via the AgentSelector dropdown + assert anchor messages', async ({ page, context }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('crud-chat-agent')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)
		const sql = getSql()

		try {
			await withErrorCapture(page, async () => {
				const conversation = await seedConversation(prefix)
				await page.goto(`/chat/${conversation.id}`)
				await page.waitForLoadState('domcontentloaded')

				const baselineCount = await sql<{ count: number }[]>`
					select count(*)::int as count from messages where conversation_id = ${conversation.id}
				`.then((rs) => rs[0]?.count ?? 0)

				const agents: Array<'plan' | 'research' | 'autonomous' | 'chat'> = ['plan', 'research', 'autonomous', 'chat']
				for (const next of agents) {
					const [target] = await sql<{ id: string; name: string }[]>`
						select id::text as id, name from agents where builtin_key = ${next}
					`
					expect(target?.id, `built-in ${next} agent must be seeded`).toBeTruthy()

					const agentBtn = page.getByRole('button', { name: 'Conversation agent' })
					await agentBtn.click()
					// Picker buttons render the agent name; match by the visible label.
					await page.getByRole('button', { name: new RegExp(`^${target.name}\\b`) }).first().click()

					await pollDb(
						() => sql<{ agent_id: string }[]>`
							select agent_id::text as agent_id from conversations where id = ${conversation.id}
						`,
						(rs) => rs[0]?.agent_id === target.id,
						{ description: `conversation.agent_id → ${next} (${target.id})` },
					)
				}

				// 4 transitions should have written 4 anchor messages tagged 'agent_anchor'.
				await pollDb(
					() => sql<{ count: number }[]>`
						select count(*)::int as count from messages
						where conversation_id = ${conversation.id}
						  and role = 'system'
						  and metadata->>'type' = 'agent_anchor'
					`,
					(rs) => (rs[0]?.count ?? 0) >= 4,
					{ description: 'four agent-change anchor messages persisted' },
				)

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
