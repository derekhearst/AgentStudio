import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * A reuse-mode automation sees the END of its conversation, not the beginning.
 *
 * The history query was `order by sequence asc limit 12` — the FIRST twelve messages. In
 * `reuse` mode the conversation gains a prompt and a reply every tick, so from the seventh
 * run on, every tick was shown runs 1–6 and never the one before it. The default prompt
 * ("Summarize important updates since the last run…") compared against a month-old state.
 */

async function seedConversation(prefix: string, turns: Array<'user' | 'assistant' | 'tool'>) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [agent] = await sql<{ id: string }[]>`select id from agents order by created_at limit 1`
	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, agent_id, model)
		values (${`${prefix} reuse thread`}, ${userId}, ${agent?.id ?? null}, 'claude-sonnet-5')
		returning id
	`
	let sequence = 0
	for (const role of turns) {
		sequence += 1
		await sql`
			insert into messages (conversation_id, role, content, sequence)
			values (${conversation.id}, ${role}::message_role, ${`${prefix} #${sequence} ${role}`}, ${sequence})
		`
	}
	return conversation.id
}

function sequenceOf(content: string): number {
	return Number(/#(\d+)/.exec(content)?.[1])
}

test.describe('automations/reuse-history — the window a reuse-mode tick sees', () => {
	test('is the latest twelve messages, oldest first', async () => {
		const prefix = uniquePrefix('automation-reuse-history')
		const sql = getSql()
		try {
			// Ten finished ticks: prompt, reply, prompt, reply…
			const turns = Array.from({ length: 20 }, (_, i): 'user' | 'assistant' => (i % 2 === 0 ? 'user' : 'assistant'))
			const conversationId = await seedConversation(prefix, turns)

			const { loadRecentAutomationHistory, AUTOMATION_HISTORY_MESSAGES } = await import(
				'../src/lib/automations/chat-followup-mode.server'
			)
			const history = await loadRecentAutomationHistory(conversationId)

			expect(history).toHaveLength(AUTOMATION_HISTORY_MESSAGES)
			expect(history.map((m) => sequenceOf(m.content))).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
			expect(history.at(-1)?.role, 'the previous run’s reply is the last thing the model sees').toBe('assistant')
			expect(history[0].role).toBe('user')
		} finally {
			await sql`delete from conversations where title like ${`${prefix}%`}`
		}
	})

	test('drops a reply whose prompt fell outside the window, and ignores tool rows', async () => {
		const prefix = uniquePrefix('automation-reuse-history-edge')
		const sql = getSql()
		try {
			// Ten ticks, a tool row in the middle, and a last prompt whose run failed before it
			// could reply. The newest twelve user/assistant rows then open on a reply.
			const turns: Array<'user' | 'assistant' | 'tool'> = []
			for (let i = 0; i < 10; i++) {
				turns.push('user', 'assistant')
				if (i === 7) turns.push('tool')
			}
			turns.push('user')
			const conversationId = await seedConversation(prefix, turns)

			const { loadRecentAutomationHistory } = await import('../src/lib/automations/chat-followup-mode.server')
			const history = await loadRecentAutomationHistory(conversationId)

			expect(history.every((m) => m.role !== ('tool' as string)), 'tool rows are not context').toBe(true)
			expect(history[0].role, 'the window starts on a prompt, not an orphaned reply').toBe('user')
			expect(history).toHaveLength(11)
			// The unanswered prompt is the newest row, and it is there.
			expect(sequenceOf(history.at(-1)!.content)).toBe(turns.length)
		} finally {
			await sql`delete from conversations where title like ${`${prefix}%`}`
		}
	})
})
