/**
 * Pin and archive (#18).
 *
 * Archive is the everyday way to tidy the sidebar: it hides a conversation from the default
 * list and keeps everything — messages, runs, cost history and the memories mined from it.
 * Delete stays available but is the exception, because it takes the runs and the memory
 * links with it and cannot be undone.
 *
 * The rules, all enforced here rather than in the UI:
 *   - Pinning un-archives, and archiving un-pins. A chat is in exactly one of the pinned
 *     group, the normal list or the archive.
 *   - Neither touches `updatedAt`. That is the list's order ("latest activity"), and putting
 *     a chat away or pinning it is not activity — it would jump to the top otherwise.
 *   - A message the user sends brings an archived chat back (`unarchiveOnUserMessage`).
 *     Automations and monitors that post into a chat do not: a chat archived on purpose
 *     should not reappear every time a scheduled job writes to it.
 */

import { and, eq, isNotNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations } from '$lib/sessions/sessions.schema'

export type ConversationLifecycleState = {
	id: string
	pinnedAt: Date | null
	archivedAt: Date | null
}

const lifecycleColumns = {
	id: conversations.id,
	pinnedAt: conversations.pinnedAt,
	archivedAt: conversations.archivedAt,
}

export async function setConversationPinnedForUser(
	userId: string,
	conversationId: string,
	pinned: boolean,
): Promise<ConversationLifecycleState> {
	const [row] = await db
		.update(conversations)
		.set(pinned ? { pinnedAt: new Date(), archivedAt: null } : { pinnedAt: null })
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.returning(lifecycleColumns)
	if (!row) throw new Error('Conversation not found')
	return row
}

export async function setConversationArchivedForUser(
	userId: string,
	conversationId: string,
	archived: boolean,
): Promise<ConversationLifecycleState> {
	const [row] = await db
		.update(conversations)
		.set(archived ? { archivedAt: new Date(), pinnedAt: null } : { archivedAt: null })
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.returning(lifecycleColumns)
	if (!row) throw new Error('Conversation not found')
	return row
}

/**
 * The user wrote in an archived chat, so it is back in use. Called when the chat stream
 * stores the user's message; nothing else calls it. A no-op for a chat that is not archived.
 */
export async function unarchiveOnUserMessage(conversationId: string): Promise<void> {
	await db
		.update(conversations)
		.set({ archivedAt: null })
		.where(and(eq(conversations.id, conversationId), isNotNull(conversations.archivedAt)))
}
