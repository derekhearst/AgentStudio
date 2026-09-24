import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getActiveUserId, getSql, seedConversation, uniquePrefix } from './helpers'
import { registerRunHandle, type EngineQueryHandle } from '../src/lib/engine/run-registry.server'

/**
 * #35 — background commands are turn-scoped, and everything around them has to say so.
 *
 * - The model is told. The CLI's own tool result promises a notification "when it
 *   completes" and suggests reading the output file; in AgentStudio the command ends with the
 *   reply and the file is outside the workspace, so the system prompt corrects both.
 * - Deleting a conversation stops its live turn, and with it the commands that turn started.
 *   Before, the row was deleted and the run carried on with nothing left that could reach it.
 *
 * These call the server modules directly, so the registry they touch is this worker's: a
 * fake handle registered here is the one the delete reaches.
 */

async function seedRun(conversationId: string, opts: { finished?: boolean } = {}) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, state, source, started_at, finished_at)
		values (
			${conversationId},
			${userId},
			${opts.finished ? 'completed' : 'running'},
			'chat_stream',
			now(),
			${opts.finished ? sql`now()` : null}
		)
		returning id
	`
	return run.id
}

function fakeHandle(onInterrupt: () => void): EngineQueryHandle {
	return {
		interrupt: async () => onInterrupt(),
		stopTask: async () => {},
		getContextUsage: async () => null,
	}
}

async function conversationExists(id: string) {
	const sql = getSql()
	const rows = await sql`select 1 from conversations where id = ${id}`
	return rows.length > 0
}

test.describe('the model is told background commands end with its reply', () => {
	test('both tool policies carry it', async () => {
		const { buildToolPolicySlot, BACKGROUND_COMMAND_POLICY_LINES } = await import('../src/lib/chat/stream-slots.server')
		expect(BACKGROUND_COMMAND_POLICY_LINES.join('\n')).toMatch(/run_in_background only runs until your reply ends/)
		expect(BACKGROUND_COMMAND_POLICY_LINES.join('\n')).toMatch(/outside your workspace, so Read cannot open it/)
		for (const orchestrator of [true, false]) {
			const slot = buildToolPolicySlot(orchestrator)
			for (const line of BACKGROUND_COMMAND_POLICY_LINES) {
				expect(slot.content, `orchestrator=${orchestrator}`).toContain(line)
			}
		}
	})
})

test.describe('deleting a conversation stops what it is running', () => {
	test('the live turn is interrupted before the conversation goes', async () => {
		const prefix = uniquePrefix('chat-delete-live')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			const runId = await seedRun(conv.id)
			let interrupted = 0
			let existedWhenInterrupted: boolean | null = null
			const release = registerRunHandle(runId, {
				...fakeHandle(() => {}),
				// The delete waits for the interrupt, so this sees the order the two happen in.
				interrupt: async () => {
					interrupted++
					existedWhenInterrupted = await conversationExists(conv.id)
				},
			})
			try {
				const { deleteConversationForUser } = await import('../src/lib/chat/conversation-delete.server')
				expect(await deleteConversationForUser(userId, conv.id)).toEqual({ deleted: true, stoppedRun: true })
				expect(interrupted).toBe(1)
				// Stopped while the run could still be found by its conversation, then deleted.
				expect(existedWhenInterrupted).toBe(true)
				expect(await conversationExists(conv.id)).toBe(false)
			} finally {
				release()
			}
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a conversation with nothing running is simply deleted', async () => {
		const prefix = uniquePrefix('chat-delete-idle')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			const finishedId = await seedRun(conv.id, { finished: true })
			let interrupted = 0
			const release = registerRunHandle(finishedId, fakeHandle(() => interrupted++))
			try {
				const { deleteConversationForUser } = await import('../src/lib/chat/conversation-delete.server')
				expect(await deleteConversationForUser(userId, conv.id)).toEqual({ deleted: true, stoppedRun: false })
				expect(interrupted).toBe(0)
			} finally {
				release()
			}
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test("someone else's conversation is neither stopped nor deleted", async () => {
		const prefix = uniquePrefix('chat-delete-stranger')
		await cleanupPrefixedRecords(prefix)
		try {
			const conv = await seedConversation(prefix, { userId: await getActiveUserId() })
			const runId = await seedRun(conv.id)
			let interrupted = 0
			const release = registerRunHandle(runId, fakeHandle(() => interrupted++))
			try {
				const { deleteConversationForUser } = await import('../src/lib/chat/conversation-delete.server')
				expect(await deleteConversationForUser(randomUUID(), conv.id)).toEqual({ deleted: false, stoppedRun: false })
				expect(interrupted).toBe(0)
				expect(await conversationExists(conv.id)).toBe(true)
			} finally {
				release()
			}
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
