/**
 * The one chat turn a conversation may have in flight (#129).
 *
 * A turn used to end whenever the page's connection did, so a conversation could never have
 * two. Now a turn outlives a reload, and that opened two holes:
 *
 * - A second message sent while the first turn is still working starts a second CLI on the
 *   same SDK session. Both append to one transcript, both overwrite
 *   `conversations.sdkSessionId`, both save an assistant reply. So the chat stream refuses a
 *   new turn while one is live (409, with the live run's id), and the page attaches to that
 *   run instead.
 * - A reloaded page showed nothing of the turn still running and offered no way to stop it.
 *   `getConversation` now names the live run, and the page re-attaches through
 *   `stream/resume`, Stop button included.
 *
 * "Live" means an open `chat_stream` row that this process is running — its claim in
 * `$lib/engine/run-registry.server`. Only the chat stream route creates those rows, and it
 * runs them in this process, so an open row with no claim was left behind by a restart. It
 * is not waited out for the reaper's hour: the next turn marks it canceled and goes ahead.
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { ACTIVE_CHAT_RUN_STATES } from '$lib/runs/runs.server'
import { finishChatRun } from '$lib/runs/run-lifecycle.server'
import { isRunClaimedHere } from '$lib/engine/run-registry.server'
import { logger } from '$lib/observability/logger'

export const ABANDONED_RUN_REASON =
	'Abandoned: the server restarted while this turn was running, so it could not finish.'

/** Open chat turns in the conversation, newest first. Open means not finished, in an active state. */
async function openChatRunIds(conversationId: string, userId: string): Promise<string[]> {
	const rows = await db
		.select({ id: chatRuns.id })
		.from(chatRuns)
		.where(
			and(
				eq(chatRuns.conversationId, conversationId),
				eq(chatRuns.userId, userId),
				eq(chatRuns.source, 'chat_stream'),
				isNull(chatRuns.finishedAt),
				inArray(chatRuns.state, ACTIVE_CHAT_RUN_STATES),
			),
		)
		.orderBy(desc(chatRuns.startedAt))
	return rows.map((row) => row.id)
}

/** The conversation's live chat turn, or null. Read-only: leaves an abandoned row alone. */
export async function findLiveChatRun(conversationId: string, userId: string): Promise<string | null> {
	const ids = await openChatRunIds(conversationId, userId)
	return ids.find((id) => isRunClaimedHere(id)) ?? null
}

/**
 * Before a new turn starts: the live turn that should block it, or null to go ahead.
 *
 * Any open row nothing is running is marked canceled on the way, so it stops reading as
 * "in progress" everywhere else too.
 */
export async function turnInProgress(conversationId: string, userId: string): Promise<string | null> {
	const ids = await openChatRunIds(conversationId, userId)
	let live: string | null = null
	for (const id of ids) {
		if (isRunClaimedHere(id)) {
			live ??= id
			continue
		}
		if (await finishChatRun(id, { state: 'canceled', label: 'Canceled', error: ABANDONED_RUN_REASON })) {
			logger.warn('[runs] canceled a chat run nothing was running', { runId: id, conversationId })
		}
	}
	return live
}
