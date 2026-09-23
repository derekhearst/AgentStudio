/**
 * Where a turn finds the running totals its session reported last time.
 *
 * The SDK reports a resumed session's usage as a running total for the whole session
 * (`./run-result`), so a turn's own share is that total minus the previous turn's. The
 * previous total is kept on the previous turn's assistant message, as `metadata.sessionUsage`,
 * because that is the record every completed turn already writes — no new column, and a
 * conversation's history carries its own bookkeeping.
 */

import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { messages } from '$lib/sessions/sessions.schema'
import { parseSessionUsage, type SessionUsage } from './run-result'

/** The message metadata key the totals are kept under. Spelt out in the query below too. */
export const SESSION_USAGE_METADATA_KEY = 'sessionUsage'

/**
 * The latest running totals recorded for `sessionId` in this conversation, or null when
 * there are none — a fresh session, or turns that predate this bookkeeping.
 *
 * Latest by `sequence`, which is insertion order: a regenerated or edited turn still moved
 * the session's running total forward, so the newest record is the right baseline whichever
 * branch of the conversation it sits on. A client-saved partial carries no totals and is
 * skipped.
 */
export async function loadSessionUsageBaseline(
	conversationId: string,
	sessionId: string | null | undefined,
): Promise<SessionUsage | null> {
	if (!sessionId) return null
	const [row] = await db
		.select({ metadata: messages.metadata })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(messages.role, 'assistant'),
				sql`${messages.metadata}->'sessionUsage'->>'sessionId' = ${sessionId}`,
			),
		)
		.orderBy(desc(messages.sequence))
		.limit(1)
	return parseSessionUsage(row?.metadata?.[SESSION_USAGE_METADATA_KEY])
}
