import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getActiveUserId, getSql, seedConversation, uniquePrefix } from './helpers'

/**
 * Where a turn finds its session's previous running totals (#106 / #107).
 *
 * The SDK reports a resumed session's usage as a total for the whole session, so the turn's
 * own share is that total minus the previous turn's — kept on the previous assistant
 * message as `metadata.sessionUsage`. These pin which message that is.
 */

const totals = (sessionId: string, inputTokens: number, costUsd: number) => ({
	sessionId,
	inputTokens,
	outputTokens: 10,
	cacheCreationTokens: 0,
	cacheReadTokens: 0,
	costUsd,
})

async function addAssistant(conversationId: string, sequence: number, metadata: Record<string, unknown>) {
	const sql = getSql()
	await sql`
		insert into messages (conversation_id, role, content, metadata, tool_calls, sequence)
		values (${conversationId}, 'assistant', 'reply', ${sql.json(metadata as never)}, '[]'::jsonb, ${sequence})
	`
}

test('the latest totals for the resumed session are the baseline', async () => {
	const prefix = uniquePrefix('session-usage')
	await cleanupPrefixedRecords(prefix)
	try {
		const userId = await getActiveUserId()
		const conv = await seedConversation(prefix, { userId })
		await addAssistant(conv.id, 10, { sessionUsage: totals('s1', 100, 0.1) })
		await addAssistant(conv.id, 11, { sessionUsage: totals('s1', 250, 0.2) })
		// A later message from a different session, and a client-saved partial with none.
		await addAssistant(conv.id, 12, { sessionUsage: totals('s2', 999, 9) })
		await addAssistant(conv.id, 13, { partial: true })

		const { loadSessionUsageBaseline } = await import('../src/lib/engine/session-usage.server')
		expect(await loadSessionUsageBaseline(conv.id, 's1')).toEqual(totals('s1', 250, 0.2))
		expect(await loadSessionUsageBaseline(conv.id, 's2')).toEqual(totals('s2', 999, 9))
		// Nothing recorded for it — a conversation from before the bookkeeping.
		expect(await loadSessionUsageBaseline(conv.id, 's3')).toBeNull()
		// No session to resume, no baseline.
		expect(await loadSessionUsageBaseline(conv.id, null)).toBeNull()
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
