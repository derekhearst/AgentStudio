/**
 * Public memory facade — the surface used by chat, agents, and the bench harness.
 */

import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { messages, conversations } from '$lib/sessions/sessions.schema'
import { memoryDrawers, memoryMessageTombstones } from '$lib/memory/memory.schema'
import { findTombstonedMessageIds } from '$lib/memory/tombstones.server'
import { mineSession, mineSessions, type MineResult, type MiningSession } from '$lib/memory/mining.server'
import { recall, type RecallOptions, type RetrievedDrawer } from '$lib/memory/retrieval.server'
import { recordRecallEvents, type RecallSource } from '$lib/memory/recall-log.server'
import { rerank } from '$lib/memory/rerank.server'

export type { RetrievedDrawer, RecallOptions } from '$lib/memory/retrieval.server'
export type { MineResult } from '$lib/memory/mining.server'

/** The message roles the miner turns into drawers. */
const MINED_ROLES = ['user', 'assistant', 'system'] as const

/**
 * Mine a conversation's not-yet-mined messages into the palace. Safe to run again after every
 * exchange: a message with a drawer, or a tombstone (its drawer was deleted, its conversation
 * forgotten, or an exclusion rule dropped it), is skipped.
 */
export async function mineConversation(opts: {
	conversationId: string
	userIdOverride?: string
}): Promise<MineResult> {
	const empty: MineResult = {
		drawerIds: [],
		wingIds: [],
		roomIds: [],
		closetIds: [],
		excludedTurns: 0,
		excludedByRule: [],
	}
	const [conversation] = await db.select().from(conversations).where(eq(conversations.id, opts.conversationId)).limit(1)
	if (!conversation) return empty

	const userId = opts.userIdOverride ?? conversation.userId
	if (!userId) return empty

	const messageRows = await db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, opts.conversationId))
		.orderBy(asc(messages.sequence))

	// Skip messages that have already been mined into a drawer, and messages the user took
	// out of memory — without the tombstones a deleted drawer would be re-mined next turn.
	const messageIds = messageRows.map((row) => row.id)
	const minedIds = await findTombstonedMessageIds(messageIds)
	if (messageIds.length > 0) {
		const existing = await db
			.select({ sourceMessageId: memoryDrawers.sourceMessageId })
			.from(memoryDrawers)
			.where(inArray(memoryDrawers.sourceMessageId, messageIds))
		for (const row of existing) {
			if (row.sourceMessageId) minedIds.add(row.sourceMessageId)
		}
	}

	const session: MiningSession = {
		conversationId: opts.conversationId,
		occurredAt: conversation.createdAt,
		sessionLabel: conversation.title ?? undefined,
		turns: messageRows
			.filter((row) => !minedIds.has(row.id))
			.filter((row) => (MINED_ROLES as readonly string[]).includes(row.role))
			.map((row) => ({
				role: row.role as 'user' | 'assistant' | 'system',
				content: typeof row.content === 'string' ? row.content : String(row.content ?? ''),
				sourceMessageId: row.id,
			}))
			.filter((turn) => turn.content.trim().length > 0),
	}

	return mineSession({
		userId,
		agentId: conversation.agentId ?? null,
		session,
	})
}

/**
 * A message the miner would still pick up: a mined role, some content, no drawer and no
 * tombstone. Written against `messages`, for queries that select from it.
 */
function isUnminedMessage() {
	return and(
		inArray(messages.role, [...MINED_ROLES]),
		// Some non-whitespace, as the miner's own `trim()` filter requires.
		sql`${messages.content} ~ '[^[:space:]]'`,
		notExists(
			db
				.select({ one: sql`1` })
				.from(memoryDrawers)
				.where(eq(memoryDrawers.sourceMessageId, messages.id)),
		),
		notExists(
			db
				.select({ one: sql`1` })
				.from(memoryMessageTombstones)
				.where(eq(memoryMessageTombstones.messageId, messages.id)),
		),
	)
}

/**
 * The user's conversations that hold at least one message the miner would still pick up.
 * What "Mine pending" sweeps.
 */
export async function listConversationsWithUnminedMessages(userId: string): Promise<string[]> {
	const rows = await db
		.selectDistinct({ id: conversations.id })
		.from(conversations)
		.innerJoin(messages, eq(messages.conversationId, conversations.id))
		.where(and(eq(conversations.userId, userId), isUnminedMessage()))
	return rows.map((row) => row.id)
}

/**
 * The conversation's messages the miner would still pick up, as a subquery — for a mining job
 * to ask, in the statement that lets go of its dedupe key, whether anything arrived while it
 * was mining (see `releaseDedupeKey`).
 */
export function unminedMessagesOf(conversationId: string) {
	return db
		.select({ one: sql`1` })
		.from(messages)
		.where(and(eq(messages.conversationId, conversationId), isUnminedMessage()))
}

/**
 * High-level recall used by chat — returns ranked drawers, optionally reranked.
 *
 * Every recall writes its component scores to `memory_recall_events` (unless
 * `logRecall: false`), which is what powers "why was this recalled?" on the drawer.
 * Logging is best-effort and never fails the recall.
 */
export async function recallForUser(
	userId: string,
	query: string,
	options: RecallOptions & {
		useRerank?: boolean
		rerankModel?: string
		logRecall?: boolean
		recallSource?: RecallSource
	} = {},
): Promise<RetrievedDrawer[]> {
	const candidatePoolSize = options.candidatePoolSize ?? (options.useRerank ? 20 : 50)
	const initial = await recall(userId, query, {
		...options,
		topK: options.useRerank ? candidatePoolSize : (options.topK ?? 5),
		candidatePoolSize,
	})
	const final = options.useRerank
		? await rerank(query, initial, { model: options.rerankModel, keepTopK: options.topK ?? 5 })
		: initial

	if (options.logRecall !== false) {
		await recordRecallEvents({
			userId,
			query,
			source: options.recallSource ?? 'chat',
			drawers: final,
			weights: {
				semantic: options.semanticWeight ?? 1,
				keyword: options.keywordWeight ?? 0.35,
				temporal: options.temporalWeight ?? 0.25,
			},
		})
	}

	return final
}

/**
 * Render retrieved drawers as a `<memory_context>` system block for chat injection.
 *
 * `includeScores` appends the component scores to each header — the same numbers the
 * palace UI shows under "why was this recalled?". Off by default so the prompt text stays
 * stable for callers that don't want the extra tokens.
 */
export function renderMemoryContext(drawers: RetrievedDrawer[], options: { includeScores?: boolean } = {}): string {
	if (drawers.length === 0) return ''
	const blocks = drawers.map((drawer, i) => {
		const date = drawer.occurredAt.toISOString().slice(0, 10)
		const why = options.includeScores
			? ` · why: sem ${drawer.semanticScore.toFixed(2)} kw ${drawer.keywordScore.toFixed(2)} tmp ${drawer.temporalScore.toFixed(2)}${drawer.pinned ? ' pinned' : ''}`
			: ''
		const header = `[${i + 1}] ${date} · ${drawer.wingName} › ${drawer.closetTopic}${why}`
		return `${header}\n${drawer.content}`
	})
	return `<memory_context>\n${blocks.join('\n\n')}\n</memory_context>`
}

export { mineSession, mineSessions }
