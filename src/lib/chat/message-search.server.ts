/**
 * Conversation search (#18): the index writer, its backfill, and the query.
 *
 * Every message gets one `message_search` row holding `buildMessageSearchText(message)`;
 * Postgres generates the tsvector from it and a GIN index serves the search. See
 * `messageSearch` in the sessions schema for why it is a side table, and
 * ./message-search-text for what is indexed.
 *
 * Indexing is best-effort and happens after the message is committed. A message write never
 * fails because of it, and nothing waits on it: the three places that write messages hand the
 * row to `scheduleMessageIndex` and carry on. Anything missed — a failed write, a message
 * from before this existed, a row built by an older version of the rules — is caught by
 * `backfillMessageSearch`, which runs in the background at every boot.
 */

import { and, desc, eq, ilike, isNull, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations, messageSearch } from '$lib/sessions/sessions.schema'
import { logger } from '$lib/observability/logger'
import { buildMessageSearchText, SEARCH_BUILDER_VERSION } from '$lib/chat/message-search-text'
import { normalizeSearchInput, SEARCH_QUERY_MIN_CHARS, SEARCH_QUERY_MAX_CHARS } from '$lib/chat/conversation-search'
import {
	backfillBatchQuery,
	contentSearchQuery,
	textQuery,
	type BackfillRow,
	type ContentSearchRow,
} from '$lib/chat/message-search-sql'

type IndexableMessage = {
	id: string
	conversationId: string
	role: string
	content: string
	metadata?: unknown
	attachments?: unknown
	toolCalls?: unknown
}

function searchRow(message: IndexableMessage) {
	return {
		messageId: message.id,
		conversationId: message.conversationId,
		body: buildMessageSearchText(message),
		builderVersion: SEARCH_BUILDER_VERSION,
		updatedAt: new Date(),
	}
}

/**
 * Write (or rewrite) the search rows for these messages. A message with nothing worth
 * indexing — a system anchor — still gets a row with an empty body, so the backfill knows it
 * has been seen and does not pick it up again on every boot.
 */
export async function indexMessages(rows: IndexableMessage[]): Promise<void> {
	if (rows.length === 0) return
	await db
		.insert(messageSearch)
		.values(rows.map(searchRow))
		.onConflictDoUpdate({
			target: messageSearch.messageId,
			set: {
				body: sql`excluded.body`,
				builderVersion: sql`excluded.builder_version`,
				updatedAt: sql`excluded.updated_at`,
			},
		})
}

export function indexMessage(row: IndexableMessage): Promise<void> {
	return indexMessages([row])
}

/**
 * Index a message that has just been committed, in the background. Never throws and never
 * delays the caller. A failure is logged and left to the boot backfill.
 *
 * Only for a committed row: inside an open transaction the foreign key to an uncommitted
 * message fails, and a failed statement would abort the caller's transaction.
 */
export function scheduleMessageIndex(row: IndexableMessage | null | undefined): void {
	if (!row) return
	void indexMessage(row).catch((err) => {
		logger.warn('[search] indexing a message failed; the boot backfill will retry it', {
			messageId: row.id,
			err,
		})
	})
}

/**
 * Index every message that has no search row, or one built by an older
 * `SEARCH_BUILDER_VERSION`. Walks `messages` by id in batches, so each batch starts where the
 * last one stopped and the whole pass is one read of the table. Safe to run while messages
 * are being written and in several processes at once: each write is an upsert.
 */
export async function backfillMessageSearch(options: { batchSize?: number; maxBatches?: number } = {}): Promise<{
	indexed: number
}> {
	const batchSize = Math.max(1, Math.min(options.batchSize ?? 200, 1000))
	const maxBatches = options.maxBatches ?? 100_000
	let cursor: string | null = null
	let indexed = 0

	for (let batch = 0; batch < maxBatches; batch += 1) {
		const rows: BackfillRow[] = await db.execute<BackfillRow>(backfillBatchQuery(cursor, batchSize))
		if (rows.length === 0) break

		await indexMessages(
			rows.map((row) => ({
				id: row.id,
				conversationId: row.conversation_id,
				role: row.role,
				content: row.content ?? '',
				attachments: row.attachments,
				metadata: { blocks: row.blocks },
				toolCalls: row.tool_calls,
			})),
		)
		indexed += rows.length
		cursor = rows[rows.length - 1].id
		if (rows.length < batchSize) break
	}

	return { indexed }
}

export type ConversationSearchHit = {
	conversationId: string
	title: string
	updatedAt: Date
	pinned: boolean
	archived: boolean
	/** The title contains the search text. */
	titleMatch: boolean
	/** The best-matching message, when one matched. */
	match: {
		messageId: string
		role: string
		createdAt: Date
		/** Plain text with the matched words between `SNIPPET_START` and `SNIPPET_STOP`. */
		snippet: string
	} | null
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * Search one user's conversations: message text and tool calls (full-text, ranked), plus
 * titles (substring). One result per conversation, best first. Archived conversations only
 * when asked for. Never another user's.
 */
export async function searchUserConversations(
	userId: string,
	rawQuery: string,
	options: { includeArchived?: boolean; limit?: number } = {},
): Promise<ConversationSearchHit[]> {
	const q = normalizeSearchInput(rawQuery).slice(0, SEARCH_QUERY_MAX_CHARS)
	if (q.length < SEARCH_QUERY_MIN_CHARS) return []
	const limit = Math.max(1, Math.min(options.limit ?? 30, 50))
	const includeArchived = options.includeArchived === true
	const tsq = textQuery(q)

	const contentSearch = async () => {
		if (!tsq) return []
		return db.transaction(async (tx) => {
			// A query of only stop words ("the") makes Postgres raise a NOTICE per call, which
			// the client logs as a warning. Expected here, so not worth a log line each time.
			await tx.execute(sql`select set_config('client_min_messages', 'warning', true)`)
			return tx.execute<ContentSearchRow>(contentSearchQuery({ userId, tsq, includeArchived, limit }))
		})
	}

	const titleSearch = () =>
		db
			.select({
				id: conversations.id,
				title: conversations.title,
				updatedAt: conversations.updatedAt,
				pinnedAt: conversations.pinnedAt,
				archivedAt: conversations.archivedAt,
			})
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, userId),
					ilike(conversations.title, `%${escapeLike(q)}%`),
					includeArchived ? undefined : isNull(conversations.archivedAt),
				),
			)
			.orderBy(desc(conversations.updatedAt))
			.limit(limit)

	const [contentRows, titleRows] = await Promise.all([contentSearch(), titleSearch()])

	const hits = new Map<string, ConversationSearchHit & { score: number }>()
	for (const row of contentRows) {
		hits.set(row.conversation_id, {
			conversationId: row.conversation_id,
			title: row.title,
			updatedAt: new Date(row.updated_at),
			pinned: row.pinned_at !== null,
			archived: row.archived_at !== null,
			titleMatch: false,
			match: {
				messageId: row.message_id,
				role: row.role,
				createdAt: new Date(row.message_created_at),
				snippet: row.snippet ?? '',
			},
			score: Number(row.rank) || 0,
		})
	}
	for (const row of titleRows) {
		const existing = hits.get(row.id)
		if (existing) {
			existing.titleMatch = true
			existing.score += 1
			continue
		}
		hits.set(row.id, {
			conversationId: row.id,
			title: row.title,
			updatedAt: row.updatedAt,
			pinned: row.pinnedAt !== null,
			archived: row.archivedAt !== null,
			titleMatch: true,
			match: null,
			score: 1,
		})
	}

	return [...hits.values()]
		.sort((a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime())
		.slice(0, limit)
		.map(({ score: _score, ...hit }) => hit)
}
