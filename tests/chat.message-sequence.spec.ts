import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getActiveAdminUserId, getSql, uniquePrefix } from './helpers'

/**
 * Validates the per-conversation `sequence` invariant:
 *   - inserts are sequential and unique inside one conversation
 *   - the (conversation_id, sequence) unique index rejects collisions
 *
 * The migration that introduced this column (drizzle/0047_messages_sequence.sql) backfills
 * existing rows by (created_at, id), so any new inserts must continue from max+1. This test
 * exercises both invariants directly via raw SQL — the helper that wraps this logic in
 * application code lives at $lib/chat/insert-message.server.ts.
 */
test.describe('messages.sequence invariant', () => {
	test('per-conversation sequences are monotonic and unique', async () => {
		const sql = getSql()
		const userId = await getActiveAdminUserId()
		const prefix = uniquePrefix('msgseq-monotonic')

		try {
			const [conversation] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} chat`}, ${userId}, ${'anthropic/claude-sonnet-4'}, 0, '0')
				returning id
			`

			// Three sequential inserts. Each picks max(sequence)+1 atomically the same way the
			// production helper does.
			for (let i = 0; i < 3; i++) {
				await sql`
					insert into messages (conversation_id, role, content, model, metadata, tool_calls, sequence)
					values (
						${conversation.id},
						${i % 2 === 0 ? 'user' : 'assistant'},
						${`message ${i}`},
						${'anthropic/claude-sonnet-4'},
						'{}'::jsonb,
						'[]'::jsonb,
						(select coalesce(max(sequence), 0) + 1 from messages where conversation_id = ${conversation.id})
					)
				`
			}

			const rows = await sql<{ sequence: number; content: string }[]>`
				select sequence, content from messages where conversation_id = ${conversation.id} order by sequence
			`
			expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3])
			expect(rows.map((r) => r.content)).toEqual(['message 0', 'message 1', 'message 2'])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('unique index rejects duplicate (conversation_id, sequence)', async () => {
		const sql = getSql()
		const userId = await getActiveAdminUserId()
		const prefix = uniquePrefix('msgseq-collision')

		try {
			const [conversation] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} chat`}, ${userId}, ${'anthropic/claude-sonnet-4'}, 0, '0')
				returning id
			`

			await sql`
				insert into messages (conversation_id, role, content, model, metadata, tool_calls, sequence)
				values (${conversation.id}, 'user', 'first', ${'anthropic/claude-sonnet-4'}, '{}'::jsonb, '[]'::jsonb, 1)
			`

			let rejected = false
			try {
				await sql`
					insert into messages (conversation_id, role, content, model, metadata, tool_calls, sequence)
					values (${conversation.id}, 'assistant', 'second-with-same-seq', ${'anthropic/claude-sonnet-4'}, '{}'::jsonb, '[]'::jsonb, 1)
				`
			} catch (err) {
				rejected = true
				// postgres-js surfaces unique violations with code 23505
				expect((err as { code?: string }).code).toBe('23505')
			}
			expect(rejected).toBe(true)

			// Verify the original row is intact.
			const rows = await sql<{ count: number }[]>`
				select count(*)::int as count from messages where conversation_id = ${conversation.id}
			`
			expect(rows[0].count).toBe(1)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
