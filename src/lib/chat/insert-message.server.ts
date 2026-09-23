import { eq, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { getPostgresErrorCode } from '$lib/db/migrations.server'
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
 * db handle.
 *
 * Each attempt runs in its own nested transaction: a real one on the db handle, a
 * savepoint inside a caller's transaction. That is what makes the retry work inside one.
 * A unique violation aborts the whole Postgres transaction it happens in, so without the
 * savepoint the retry's `MAX(sequence)` lookup failed with 25P02 ("current transaction is
 * aborted") instead — the final assistant reply of a turn was lost whenever a Stop's
 * partial save or a detached run wrote to the conversation at the same moment.
 */
export async function insertMessageWithSequence(
	values: InsertValues,
	executor: Executor = db,
): Promise<typeof messages.$inferSelect> {
	let attempt = 0
	while (true) {
		attempt += 1
		try {
			return await executor.transaction(async (attemptTx) => {
				const [{ next }] = await attemptTx
					.select({ next: sql<number>`COALESCE(MAX(${messages.sequence}), 0) + 1` })
					.from(messages)
					.where(eq(messages.conversationId, values.conversationId))

				const [row] = await attemptTx
					.insert(messages)
					.values({ ...values, sequence: next })
					.returning()

				return row
			})
		} catch (err) {
			// Postgres unique-violation = SQLSTATE 23505. Drizzle wraps the driver's error, so
			// the code is read through `cause`. Retry with a fresh max+1 lookup; cap the
			// attempts so a runaway hot conversation never spins forever.
			if (getPostgresErrorCode(err) === '23505' && attempt < MAX_SEQUENCE_RETRIES) {
				continue
			}
			throw err
		}
	}
}
