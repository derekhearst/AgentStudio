/**
 * The recent-conversations list behind the sidebar and the home page (`getConversations`).
 *
 * Each row needs one snippet: the conversation's latest assistant message. The first
 * version found it by loading every assistant message in the database — every user's,
 * every column, `metadata.blocks` with its full tool output included — and scanning that
 * list once per conversation. It ran on every page load, so the cost of opening any page
 * grew with the whole instance's history. It is now one row per listed conversation,
 * content only, picked by `sequence`, which is the canonical per-conversation order and
 * what the `(conversation_id, sequence)` unique index serves.
 */

import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { chatRuns } from '$lib/runs/runs.schema'

const RECENT_CONVERSATION_LIMIT = 50
/** Pinned chats are listed in full on top of the recent ones, up to this many. */
const PINNED_CONVERSATION_LIMIT = 100
const ARCHIVED_CONVERSATION_LIMIT = 200
/**
 * The row's preview line. The sidebar and the home page each show one line of it, so the
 * whole reply — a long one is tens of kilobytes — never needs to reach the browser.
 */
const LAST_MESSAGE_PREVIEW_CHARS = 280
const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'waiting_tool_approval', 'waiting_user_input'])

type ConversationRow = typeof conversations.$inferSelect

/**
 * The default list (#18): every pinned conversation, then the most recent unpinned ones.
 * Archived conversations are left out — they have their own list,
 * `listArchivedConversations`, and come back when unarchived or written in.
 */
export async function listRecentConversations(userId: string, limit = RECENT_CONVERSATION_LIMIT) {
	const notArchived = and(eq(conversations.userId, userId), isNull(conversations.archivedAt))
	const [pinned, recent] = await Promise.all([
		db
			.select()
			.from(conversations)
			.where(and(notArchived, isNotNull(conversations.pinnedAt)))
			.orderBy(desc(conversations.pinnedAt))
			.limit(PINNED_CONVERSATION_LIMIT),
		db
			.select()
			.from(conversations)
			.where(and(notArchived, isNull(conversations.pinnedAt)))
			.orderBy(desc(conversations.updatedAt))
			.limit(limit),
	])
	return withPreviewAndRun(userId, [...pinned, ...recent])
}

/** The archive (#18): archived conversations, most recently archived first. */
export async function listArchivedConversations(userId: string, limit = ARCHIVED_CONVERSATION_LIMIT) {
	const rows = await db
		.select()
		.from(conversations)
		.where(and(eq(conversations.userId, userId), isNotNull(conversations.archivedAt)))
		.orderBy(desc(conversations.archivedAt))
		.limit(limit)
	return withPreviewAndRun(userId, rows)
}

async function withPreviewAndRun(userId: string, rows: ConversationRow[]) {
	const conversationIds = rows.map((row) => row.id)
	if (conversationIds.length === 0) return []

	const [lastMessages, activeRuns] = await Promise.all([
		db
			.selectDistinctOn([messages.conversationId], {
				conversationId: messages.conversationId,
				content: sql<string>`left(${messages.content}, ${LAST_MESSAGE_PREVIEW_CHARS})`,
			})
			.from(messages)
			.where(and(eq(messages.role, 'assistant'), inArray(messages.conversationId, conversationIds)))
			.orderBy(messages.conversationId, desc(messages.sequence)),
		db
			.select({
				id: chatRuns.id,
				conversationId: chatRuns.conversationId,
				state: chatRuns.state,
				label: chatRuns.label,
				startedAt: chatRuns.startedAt,
				lastHeartbeatAt: chatRuns.lastHeartbeatAt,
				updatedAt: chatRuns.updatedAt,
				error: chatRuns.error,
			})
			.from(chatRuns)
			.where(
				and(
					eq(chatRuns.userId, userId),
					isNull(chatRuns.finishedAt),
					inArray(chatRuns.conversationId, conversationIds),
				),
			)
			.orderBy(desc(chatRuns.updatedAt)),
	])

	const lastByConversation = new Map(lastMessages.map((message) => [message.conversationId, message.content]))

	// Newest first, so the first active run seen for a conversation is its current one.
	const activeRunByConversation = new Map<string, (typeof activeRuns)[number]>()
	for (const run of activeRuns) {
		if (!ACTIVE_RUN_STATES.has(run.state)) continue
		if (!activeRunByConversation.has(run.conversationId)) activeRunByConversation.set(run.conversationId, run)
	}

	return rows.map((conversation) => {
		const activeRun = activeRunByConversation.get(conversation.id)
		return {
			...conversation,
			lastMessage: lastByConversation.get(conversation.id) ?? null,
			activeRun: activeRun
				? {
						id: activeRun.id,
						state: activeRun.state,
						label: activeRun.label,
						startedAt: activeRun.startedAt,
						lastHeartbeatAt: activeRun.lastHeartbeatAt,
						updatedAt: activeRun.updatedAt,
						error: activeRun.error,
					}
				: null,
		}
	})
}

/**
 * A fingerprint of the user's conversation list: how many there are and when the latest
 * one last changed. The chat monitor pushes it, and a page holding the list refreshes when
 * it moves (#79) — a chat created in another tab or by an automation, a turn's reply landing
 * (which bumps `updatedAt`), a generated title (which does too), or a deletion.
 *
 * The list is a cached remote query read once per session, and nothing ever refreshed it:
 * a new chat never appeared, its title stayed "New conversation" and the order never moved
 * until a hard reload. The title in particular is written a moment after the turn ends, by
 * a background call nothing on the page can wait for, so the page has to be told.
 */
export async function conversationListVersion(userId: string): Promise<string> {
	const [row] = await db
		.select({
			count: sql<number>`count(*)::int`,
			latest: sql<string | null>`max(${conversations.updatedAt})::text`,
			// Pinning and archiving deliberately leave `updatedAt` alone (#18), so they are
			// counted and dated separately — another tab still hears about them.
			pinned: sql<number>`count(${conversations.pinnedAt})::int`,
			latestPin: sql<string | null>`max(${conversations.pinnedAt})::text`,
			archived: sql<number>`count(${conversations.archivedAt})::int`,
			latestArchive: sql<string | null>`max(${conversations.archivedAt})::text`,
		})
		.from(conversations)
		.where(eq(conversations.userId, userId))
	return [
		row?.count ?? 0,
		row?.latest ?? '',
		row?.pinned ?? 0,
		row?.latestPin ?? '',
		row?.archived ?? 0,
		row?.latestArchive ?? '',
	].join(':')
}
