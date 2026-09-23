import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * #4 / #77 — the sidebar's recent-conversations list.
 *
 * It found each row's snippet by loading every assistant message in the database, for every
 * user, and scanning that list once per conversation — on every page load. It now asks for
 * one row per listed conversation. These pin what the list still has to say: the latest
 * assistant reply by the conversation's own order, nothing for a conversation with no reply,
 * and the live run.
 */
test('each conversation carries its latest assistant reply, by sequence', async () => {
	const sql = getSql()
	const userId = await getActiveUserId()
	const prefix = uniquePrefix('conv-list')
	const { listRecentConversations } = await import('../src/lib/chat/conversation-list.server')

	try {
		const [answered] = await sql<{ id: string }[]>`
			insert into conversations (title, user_id, model, total_tokens, total_cost)
			values (${`${prefix} answered`}, ${userId}, ${'anthropic/claude-sonnet-4'}, 0, '0')
			returning id
		`
		const [unanswered] = await sql<{ id: string }[]>`
			insert into conversations (title, user_id, model, total_tokens, total_cost)
			values (${`${prefix} unanswered`}, ${userId}, ${'anthropic/claude-sonnet-4'}, 0, '0')
			returning id
		`
		// The newest reply by sequence carries the OLDER timestamp: `sequence` is the order a
		// conversation is read in, and a timestamp tie or skew must not pick the wrong reply.
		await sql`
			insert into messages (conversation_id, role, content, metadata, tool_calls, sequence, created_at)
			values
				(${answered.id}, 'user', 'q1', '{}'::jsonb, '[]'::jsonb, 1, now() - interval '4 minutes'),
				(${answered.id}, 'assistant', 'older reply', '{}'::jsonb, '[]'::jsonb, 2, now() - interval '1 minute'),
				(${answered.id}, 'user', 'q2', '{}'::jsonb, '[]'::jsonb, 3, now() - interval '3 minutes'),
				(${answered.id}, 'assistant', 'newest reply', '{}'::jsonb, '[]'::jsonb, 4, now() - interval '2 minutes'),
				(${unanswered.id}, 'user', 'still waiting', '{}'::jsonb, '[]'::jsonb, 1, now())
		`
		const [run] = await sql<{ id: string }[]>`
			insert into chat_runs (conversation_id, user_id, state, source, label)
			values (${answered.id}, ${userId}, 'running', 'chat_stream', ${`${prefix} run`})
			returning id
		`

		const list = await listRecentConversations(userId)
		const byId = new Map(list.map((row) => [row.id, row]))

		expect(byId.get(answered.id)?.lastMessage).toBe('newest reply')
		expect(byId.get(answered.id)?.activeRun).toMatchObject({ id: run.id, state: 'running' })
		expect(byId.get(unanswered.id)?.lastMessage).toBeNull()
		expect(byId.get(unanswered.id)?.activeRun).toBeNull()
	} finally {
		await sql`delete from chat_runs where label like ${`${prefix}%`}`
		await cleanupPrefixedRecords(prefix)
	}
})

test('a user with no conversations gets an empty list without further queries failing', async () => {
	const { listRecentConversations } = await import('../src/lib/chat/conversation-list.server')
	// No such user: the conversation query returns nothing, and the per-conversation lookups
	// are skipped rather than run with an empty id list.
	expect(await listRecentConversations('00000000-0000-4000-8000-000000000000')).toEqual([])
})
