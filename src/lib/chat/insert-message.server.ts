import { eq, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { messages } from '$lib/sessions/sessions.schema'

type Db = typeof db
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx

type InsertValues = Omit<typeof messages.$inferInsert, 'sequence'>

const MAX_SEQUENCE_RETRIES = 5

/**
 * Insert a `messages` row with a per-conversation monotonic `sequence` assigned at write
 * time. The `(conversation_id, sequence)` unique index serializes racing writers — the
 * loser hits SQLSTATE 23505 and we retry with the new max+1.
 *
 * Pass an existing transaction via `executor` when the insert is part of a larger atomic
 * write (e.g., assistant message + conversation totals). Otherwise this uses the default
 * db handle and each attempt is its own short transaction.
 */
export async function insertMessageWithSequence(
	values: InsertValues,
	executor: Executor = db,
): Promise<typeof messages.$inferSelect> {
	let attempt = 0
	while (true) {
		attempt += 1
		try {
			const [{ next }] = await executor
				.select({ next: sql<number>`COALESCE(MAX(${messages.sequence}), 0) + 1` })
				.from(messages)
				.where(eq(messages.conversationId, values.conversationId))

			const [row] = await executor
				.insert(messages)
				.values({ ...values, sequence: next })
				.returning()

			return row
		} catch (err) {
			// Postgres unique-violation = SQLSTATE 23505. Drizzle/postgres-js surfaces it
			// with `.code === '23505'`. Retry with a fresh max+1 lookup; cap at 5 attempts
			// so a runaway hot conversation never spins forever.
			const code = (err as { code?: string } | undefined)?.code
			if (code === '23505' && attempt < MAX_SEQUENCE_RETRIES) {
				continue
			}
			throw err
		}
	}
}
