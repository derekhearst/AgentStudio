import { and, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations } from '$lib/sessions/sessions.schema'
import { stopChatRun } from '$lib/runs/runs.server'

/**
 * Delete a conversation, stopping whatever it is still running first (#35).
 *
 * Deleting only removed the row. A turn in progress kept going — the CLI session, the
 * commands it had put in the background, the dev server one of them started — with nothing
 * left in the app that could reach it: its run rows cascade away with the conversation, so
 * no Stop could find it afterwards. So the live run is interrupted first, through the same
 * path as the Stop button. With no `perTaskStopAffordance` declared (`options.server` leaves
 * it unset), the CLI's interrupt also kills the session's background tasks (`sdk.d.ts`), and
 * the turn then ends, which closes the session.
 *
 * Stop first, then delete: once the row is gone, nothing can find the run by its
 * conversation. The interrupted turn still tries to save its reply into the deleted
 * conversation; that write fails and is logged by the stream route, which is the right
 * outcome for a reply nobody can see.
 *
 * Ownership is the WHERE clause on both halves, as everywhere else.
 */
export async function deleteConversationForUser(
	userId: string,
	conversationId: string,
): Promise<{ deleted: boolean; stoppedRun: boolean }> {
	const stop = await stopChatRun({ userId, conversationId, reason: 'Conversation deleted' })
	const deleted = await db
		.delete(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.returning({ id: conversations.id })
	return { deleted: deleted.length > 0, stoppedRun: stop.stopped }
}
