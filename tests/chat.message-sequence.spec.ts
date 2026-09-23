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

/**
 * #82 — the helper's 23505 retry, which never worked.
 *
 * Two things stood in its way. Drizzle wraps the driver's error, so the unique violation's
 * code sits on `cause` and the check never matched. And inside a caller's transaction —
 * `persistAssistantMessage`, the agent-switch anchor — a unique violation aborts the whole
 * transaction, so a retry's `MAX(sequence)` lookup fails with 25P02 instead. Each attempt
 * now runs in its own savepoint.
 *
 * The race is staged for real: a second connection inserts the next sequence number and
 * holds its transaction open, so the helper reads the old MAX and its INSERT blocks on the
 * unique index until that transaction commits — at which point it gets the 23505.
 */
test.describe('insertMessageWithSequence under a racing writer', () => {
	for (const mode of ['on the db handle', "inside a caller's transaction"] as const) {
		test(`retries a lost sequence race ${mode}`, async () => {
			test.setTimeout(30_000)
			const sql = getSql()
			const userId = await getActiveAdminUserId()
			const prefix = uniquePrefix('msgseq-race')
			const { db } = await import('../src/lib/db.server')
			const { messages } = await import('../src/lib/sessions/sessions.schema')
			const { insertMessageWithSequence } = await import('../src/lib/chat/insert-message.server')

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

				let releaseRacer: () => void = () => {}
				const racerGate = new Promise<void>((resolve) => (releaseRacer = resolve))
				let racerInserted: () => void = () => {}
				const racerReady = new Promise<void>((resolve) => (racerInserted = resolve))
				const racer = db.transaction(async (tx) => {
					await tx.insert(messages).values({
						conversationId: conversation.id,
						role: 'assistant',
						content: 'partial from a Stop',
						sequence: 2,
					})
					racerInserted()
					await racerGate
				})
				await racerReady

				const values = { conversationId: conversation.id, role: 'assistant' as const, content: 'final reply' }
				const writer =
					mode === 'on the db handle'
						? insertMessageWithSequence(values)
						: db.transaction((tx) => insertMessageWithSequence(values, tx))
				// Keep a rejection from going unhandled while the race is being staged.
				writer.catch(() => {})

				// The helper's INSERT is now waiting on the racer's uncommitted row.
				await expect
					.poll(
						async () => {
							const [row] = await sql<{ n: number }[]>`
								select count(*)::int as n from pg_stat_activity
								where datname = current_database()
									and wait_event_type = 'Lock'
									and query ilike 'insert into "messages"%'
							`
							return row.n
						},
						{ timeout: 10_000 },
					)
					.toBeGreaterThan(0)

				releaseRacer()
				await racer

				const written = await writer
				expect(written.sequence).toBe(3)
				const rows = await sql<{ sequence: number; content: string }[]>`
					select sequence, content from messages where conversation_id = ${conversation.id} order by sequence
				`
				expect(rows).toEqual([
					{ sequence: 1, content: 'first' },
					{ sequence: 2, content: 'partial from a Stop' },
					{ sequence: 3, content: 'final reply' },
				])
			} finally {
				await cleanupPrefixedRecords(prefix)
			}
		})
	}
})
