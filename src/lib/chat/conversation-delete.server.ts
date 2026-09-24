/**
 * Deleting a conversation (#18, #35) — the irreversible end of its lifecycle. Archiving is
 * the reversible one (`./conversation-lifecycle.server`); an archived conversation is deleted
 * exactly like any other.
 *
 * The delete itself is one statement: everything that belongs to the conversation (messages,
 * runs, their events, the search index) goes with it by cascade. What needs care is a turn
 * that is still running in it.
 *
 * Deleting under a live turn used to leave that turn running with nothing to stop it: the
 * cascade removes its `chat_runs` row, Stop finds runs through that row, and so from then on
 * Stop answered "not active" while the agent kept running tools in the sandbox — the CLI
 * session, the commands it had put in the background, the dev server one of them started.
 * Its final write then failed on a conversation that no longer existed.
 *
 * So the live turn is stopped first, the way the Stop button stops it (the run registry's
 * `interruptRun`). With no `perTaskStopAffordance` declared (`options.server` leaves it
 * unset), the CLI's interrupt also kills the session's background tasks and delegated
 * agents (`sdk.d.ts`), and the turn then ends, which closes the session (#35, #32). The turn
 * is given a moment to wind down: an interrupted turn ends with an ordinary result, saves
 * its partial reply and closes its run row, and only then lets go of its claim. The delete
 * waits for that, up to `RUN_SETTLE_MS`, and goes ahead regardless once the time is up — a
 * turn that has been told to stop will stop, and a delete must not hang on one that is slow
 * to.
 *
 * A turn another process is running (an automation in the jobs worker) cannot be reached
 * from here, exactly as Stop cannot reach it; it is short and bounded, and its writes simply
 * fail once the conversation is gone.
 *
 * Ownership is checked before anything is stopped, and is the WHERE clause on the delete.
 */

import { and, eq, isNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations } from '$lib/sessions/sessions.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import { interruptRun, isRunClaimedHere } from '$lib/engine/run-registry.server'
import { logger } from '$lib/observability/logger'

/** How long a delete waits for a stopped turn to wind down before deleting anyway. */
export const RUN_SETTLE_MS = 10_000
const RUN_SETTLE_POLL_MS = 100

export const DELETE_STOP_REASON = 'The conversation was deleted'

export type DeleteConversationResult = {
	/** False when there was no such conversation for this user. */
	deleted: boolean
	/** Turns that were running here and were stopped first. */
	stoppedRuns: number
}

/**
 * Delete one of the user's conversations, stopping its live turn first. Another user's
 * conversation is neither deleted nor has its turn touched: ownership is checked before
 * anything is stopped.
 *
 * `settleMs` and `pollMs` exist for the spec; the remote function passes neither.
 */
export async function deleteConversationForUser(
	userId: string,
	conversationId: string,
	options: { settleMs?: number; pollMs?: number } = {},
): Promise<DeleteConversationResult> {
	const settleMs = options.settleMs ?? RUN_SETTLE_MS
	const pollMs = options.pollMs ?? RUN_SETTLE_POLL_MS

	const [owned] = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.limit(1)
	if (!owned) return { deleted: false, stoppedRuns: 0 }

	// Every unfinished run, whatever state it is waiting in: `interruptRun` ignores any this
	// process is not running, so there is no harm in asking about all of them.
	const open = await db
		.select({ id: chatRuns.id })
		.from(chatRuns)
		.where(
			and(eq(chatRuns.conversationId, conversationId), eq(chatRuns.userId, userId), isNull(chatRuns.finishedAt)),
		)

	const stopping: string[] = []
	for (const { id } of open) {
		if (await interruptRun(id, DELETE_STOP_REASON)) stopping.push(id)
	}

	if (stopping.length > 0) {
		const settled = await waitForRunsToEnd(stopping, settleMs, pollMs)
		if (!settled) {
			logger.warn('[chat] deleting a conversation whose stopped turn has not finished yet', {
				conversationId,
				runIds: stopping.filter(isRunClaimedHere),
				settleMs,
			})
		}
	}

	const deleted = await db
		.delete(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.returning({ id: conversations.id })

	return { deleted: deleted.length > 0, stoppedRuns: stopping.length }
}

/**
 * Wait until none of `runIds` is claimed by this process any more — the turn's last act, after
 * its reply and run row are written. True if they all ended in time.
 */
async function waitForRunsToEnd(runIds: string[], settleMs: number, pollMs: number): Promise<boolean> {
	const deadline = Date.now() + settleMs
	while (runIds.some(isRunClaimedHere)) {
		if (Date.now() >= deadline) return false
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
	return true
}
