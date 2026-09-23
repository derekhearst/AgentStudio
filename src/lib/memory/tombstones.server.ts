import { inArray } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { memoryMessageTombstones, type MemoryTombstoneReason } from '$lib/memory/memory.schema'

/** Rows per tombstone insert; see `tombstoneMessages`. */
const TOMBSTONE_BATCH = 5_000

/**
 * Tombstones: messages the miner must not mine again (see `memoryMessageTombstones`).
 *
 * The first reason recorded for a message wins; tombstoning an already-tombstoned message is
 * a no-op, so every caller can be idempotent.
 */
export async function tombstoneMessages(
	userId: string,
	messageIds: string[],
	reason: MemoryTombstoneReason,
): Promise<void> {
	const unique = [...new Set(messageIds)]
	// In batches: each row is three bind parameters, and Postgres takes at most 65,535 per
	// statement — forgetting a long conversation in one insert would fail outright.
	for (let start = 0; start < unique.length; start += TOMBSTONE_BATCH) {
		await db
			.insert(memoryMessageTombstones)
			.values(unique.slice(start, start + TOMBSTONE_BATCH).map((messageId) => ({ messageId, userId, reason })))
			.onConflictDoNothing()
	}
}

/** Which of these messages are tombstoned. */
export async function findTombstonedMessageIds(messageIds: string[]): Promise<Set<string>> {
	if (messageIds.length === 0) return new Set()
	const rows = await db
		.select({ messageId: memoryMessageTombstones.messageId })
		.from(memoryMessageTombstones)
		.where(inArray(memoryMessageTombstones.messageId, messageIds))
	return new Set(rows.map((row) => row.messageId))
}
