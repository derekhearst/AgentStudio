import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getActiveUserId, getSql, seedConversation, uniquePrefix } from './helpers'
import { claimRun, registerRunHandle, type EngineQueryHandle } from '../src/lib/engine/run-registry.server'

/**
 * #18 — deleting a conversation while a turn is still running in it.
 *
 * The delete cascades to the conversation's `chat_runs` rows, and Stop finds a run through
 * its row — so deleting under a live turn used to leave the agent running tools with nothing
 * able to stop it. `deleteConversationForUser` now stops the turn first, the way Stop does
 * (the run registry), waits a bounded time for it to wind down, and then deletes. Pinned:
 *   - the live turn is interrupted, and the delete waits for it to end before deleting
 *   - someone else's conversation is neither deleted nor has its turn touched: ownership is
 *     checked before anything is stopped
 *   - a turn slow to stop does not hold the delete up past the settle time
 *   - with no live turn it is an ordinary delete, and a finished run is left alone
 *
 * The registry is process-local, so the "turn" here is a fake handle registered in this
 * worker — the same process the delete runs in.
 */

async function seedRun(conversationId: string, userId: string, opts: { finished?: boolean } = {}) {
	const sql = getSql()
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, state, source, started_at, updated_at, finished_at)
		values (
			${conversationId},
			${userId},
			${opts.finished ? 'completed' : 'running'},
			'chat_stream',
			now(),
			now(),
			${opts.finished ? sql`now()` : null}
		)
		returning id
	`
	return run.id
}

async function conversationExists(id: string) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`select id from conversations where id = ${id}`
	return Boolean(row)
}

function fakeHandle(onInterrupt: () => void): EngineQueryHandle {
	return {
		interrupt: async () => onInterrupt(),
		stopTask: async () => {},
		getContextUsage: async () => null,
	}
}

test.describe('deleting a conversation with a live turn', () => {
	test('stops the turn first and deletes once it has wound down', async () => {
		const prefix = uniquePrefix('conv-delete-live')
		const userId = await getActiveUserId()
		const { deleteConversationForUser } = await import('../src/lib/chat/conversation-delete.server')

		try {
			const conversation = await seedConversation(prefix, { userId })
			const runId = await seedRun(conversation.id, userId)
			const releaseClaim = claimRun(runId)
			let interrupted = 0
			const turn: { endedAt: number | null } = { endedAt: null }
			let releaseHandle = () => {}
			releaseHandle = registerRunHandle(
				runId,
				fakeHandle(() => {
					interrupted += 1
					// An interrupted turn saves its partial reply and then lets go of its claim.
					setTimeout(() => {
						releaseHandle()
						releaseClaim()
						turn.endedAt = Date.now()
					}, 150)
				}),
			)

			try {
				const result = await deleteConversationForUser(userId, conversation.id, { settleMs: 5_000, pollMs: 10 })
				const deletedAt = Date.now()

				expect(result).toEqual({ deleted: true, stoppedRuns: 1 })
				expect(interrupted).toBe(1)
				expect(turn.endedAt, 'the turn ended before the delete returned').not.toBeNull()
				expect(turn.endedAt!).toBeLessThanOrEqual(deletedAt)
				expect(await conversationExists(conversation.id)).toBe(false)
			} finally {
				releaseHandle()
				releaseClaim()
			}
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test("someone else's delete neither deletes the chat nor stops its turn", async () => {
		const prefix = uniquePrefix('conv-delete-stranger')
		const userId = await getActiveUserId()
		const { deleteConversationForUser } = await import('../src/lib/chat/conversation-delete.server')

		try {
			const conversation = await seedConversation(prefix, { userId })
			const runId = await seedRun(conversation.id, userId)
			const releaseClaim = claimRun(runId)
			let interrupted = 0
			const releaseHandle = registerRunHandle(runId, fakeHandle(() => (interrupted += 1)))

			try {
				expect(await deleteConversationForUser(randomUUID(), conversation.id, { settleMs: 200, pollMs: 10 })).toEqual({
					deleted: false,
					stoppedRuns: 0,
				})
				expect(interrupted).toBe(0)
				expect(await conversationExists(conversation.id)).toBe(true)
			} finally {
				releaseHandle()
				releaseClaim()
			}
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a turn slow to stop does not hold the delete up past the settle time', async () => {
		const prefix = uniquePrefix('conv-delete-slow')
		const userId = await getActiveUserId()
		const { deleteConversationForUser } = await import('../src/lib/chat/conversation-delete.server')

		try {
			const conversation = await seedConversation(prefix, { userId })
			const runId = await seedRun(conversation.id, userId)
			// Interrupted, but never lets go of its claim within the test.
			const releaseClaim = claimRun(runId)
			let interrupted = 0
			const releaseHandle = registerRunHandle(runId, fakeHandle(() => (interrupted += 1)))

			try {
				const startedAt = Date.now()
				const result = await deleteConversationForUser(userId, conversation.id, { settleMs: 300, pollMs: 10 })
				const elapsed = Date.now() - startedAt

				expect(result).toEqual({ deleted: true, stoppedRuns: 1 })
				expect(interrupted).toBe(1)
				expect(elapsed).toBeGreaterThanOrEqual(300)
				expect(elapsed).toBeLessThan(10_000)
				expect(await conversationExists(conversation.id)).toBe(false)
			} finally {
				releaseHandle()
				releaseClaim()
			}
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('with no live turn it is an ordinary delete, and a finished run is left alone', async () => {
		const prefix = uniquePrefix('conv-delete-idle')
		const userId = await getActiveUserId()
		const { deleteConversationForUser } = await import('../src/lib/chat/conversation-delete.server')

		try {
			const conversation = await seedConversation(prefix, { userId })
			const finishedId = await seedRun(conversation.id, userId, { finished: true })
			let interrupted = 0
			// A handle still registered for a run whose row says it finished: not asked to stop.
			const releaseHandle = registerRunHandle(finishedId, fakeHandle(() => (interrupted += 1)))

			try {
				expect(await deleteConversationForUser(userId, conversation.id, { settleMs: 200, pollMs: 10 })).toEqual({
					deleted: true,
					stoppedRuns: 0,
				})
				expect(interrupted).toBe(0)
				expect(await conversationExists(conversation.id)).toBe(false)

				// Deleting it again finds nothing.
				expect(await deleteConversationForUser(userId, conversation.id)).toEqual({ deleted: false, stoppedRuns: 0 })
			} finally {
				releaseHandle()
			}
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
