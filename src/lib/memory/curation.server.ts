/**
 * Curation — the write side of memory management (issue #37).
 *
 * Browsing the palace is not control. This module is the control surface: rewrite a
 * mined paraphrase, pin it, mark it never-recall, delete it, or forget an entire
 * conversation's worth of memories.
 *
 * The load-bearing invariant is **text and vector must agree**. A drawer's embedding is
 * derived from its content; if the content is edited and the embedding is not, semantic
 * recall keeps matching the old wording and the UI lies about why. So `editDrawerContent`
 * re-embeds, and if embedding is unavailable it writes NULL rather than leaving the old
 * vector in place — a NULL embedding drops the drawer out of semantic recall (see
 * `retrieval.server.ts`) and is picked back up by the Reorganize embedding backfill.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { embedOne } from '$lib/memory/embeddings.server'
import { memoryClosets, memoryDrawers, memoryRooms, memoryWings } from '$lib/memory/memory.schema'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { tombstoneMessages } from '$lib/memory/tombstones.server'
import { logger } from '$lib/observability/logger'

export const MAX_DRAWER_CONTENT_CHARS = 20_000

export type EditDrawerResult = {
	ok: true
	drawerId: string
	/** False when re-embedding failed and the vector was cleared instead of left stale. */
	reEmbedded: boolean
	/** Present when re-embedding failed, so the UI can say what happened. */
	embeddingError?: string
	tokenCount: number
}

/** Confirm the drawer rolls up to a wing this user owns. Returns the closet id. */
async function assertDrawerOwned(userId: string, drawerId: string): Promise<string | null> {
	const [row] = await db
		.select({ closetId: memoryDrawers.closetId })
		.from(memoryDrawers)
		.innerJoin(memoryClosets, eq(memoryClosets.id, memoryDrawers.closetId))
		.innerJoin(memoryRooms, eq(memoryRooms.id, memoryClosets.roomId))
		.innerJoin(memoryWings, eq(memoryWings.id, memoryRooms.wingId))
		.where(and(eq(memoryDrawers.id, drawerId), eq(memoryDrawers.userId, userId), eq(memoryWings.userId, userId)))
		.limit(1)
	return row?.closetId ?? null
}

/**
 * Rewrite a drawer's content and re-embed it in the same update.
 *
 * Mining paraphrases; a wrong paraphrase recalled forever is worse than no memory. This
 * is the fix path for that, and it never leaves the vector disagreeing with the text.
 */
export async function editDrawerContent(input: {
	userId: string
	drawerId: string
	content: string
}): Promise<EditDrawerResult | { ok: false; reason: 'not_found' | 'empty' | 'too_long' }> {
	const content = input.content.trim()
	if (content.length === 0) return { ok: false, reason: 'empty' }
	if (content.length > MAX_DRAWER_CONTENT_CHARS) return { ok: false, reason: 'too_long' }

	const owned = await assertDrawerOwned(input.userId, input.drawerId)
	if (!owned) return { ok: false, reason: 'not_found' }

	let embedding: number[] | null = null
	let embeddingError: string | undefined
	try {
		embedding = await embedOne(content, {
			logSource: 'memory_embed',
			metadata: { source: 'curation.edit', drawerId: input.drawerId },
		})
	} catch (error) {
		embeddingError = (error as Error).message
		logger.warn('[memory] re-embed after edit failed; clearing the vector instead of leaving it stale', {
			drawerId: input.drawerId,
			err: error,
		})
	}

	const tokenCount = Math.ceil(content.length / 4)

	await db
		.update(memoryDrawers)
		.set({
			content,
			// Either the fresh vector or NULL — never the vector for the old text.
			// Drizzle's `vector` column serializes a plain number[]; handing it a
			// pre-formatted pgvector string double-encodes and the UPDATE fails.
			embedding,
			tokenCount,
			editedAt: new Date(),
		})
		.where(and(eq(memoryDrawers.id, input.drawerId), eq(memoryDrawers.userId, input.userId)))

	return {
		ok: true,
		drawerId: input.drawerId,
		reEmbedded: embedding !== null,
		...(embeddingError ? { embeddingError } : {}),
		tokenCount,
	}
}

/** Set the pin / never-recall flags on a drawer. Either flag may be omitted. */
export async function setDrawerFlags(input: {
	userId: string
	drawerId: string
	pinned?: boolean
	neverRecall?: boolean
}): Promise<{ ok: boolean; pinned: boolean; neverRecall: boolean } | null> {
	const owned = await assertDrawerOwned(input.userId, input.drawerId)
	if (!owned) return null

	const patch: { pinned?: boolean; neverRecall?: boolean } = {}
	if (typeof input.pinned === 'boolean') patch.pinned = input.pinned
	if (typeof input.neverRecall === 'boolean') patch.neverRecall = input.neverRecall

	const [row] = await db
		.update(memoryDrawers)
		.set(patch)
		.where(and(eq(memoryDrawers.id, input.drawerId), eq(memoryDrawers.userId, input.userId)))
		.returning({ pinned: memoryDrawers.pinned, neverRecall: memoryDrawers.neverRecall })

	if (!row) return null
	return { ok: true, pinned: row.pinned, neverRecall: row.neverRecall }
}

/**
 * Delete one drawer, and keep it deleted. The conversation it came from is mined again after
 * every exchange, and the miner re-mines any message without a drawer — so the message is
 * tombstoned first. Returns false when the drawer is not this user's.
 */
export async function deleteDrawer(input: { userId: string; drawerId: string }): Promise<boolean> {
	const [drawer] = await db
		.select({ sourceMessageId: memoryDrawers.sourceMessageId })
		.from(memoryDrawers)
		.where(and(eq(memoryDrawers.id, input.drawerId), eq(memoryDrawers.userId, input.userId)))
		.limit(1)
	if (!drawer) return false
	// Tombstone before deleting: if the delete then fails, the drawer is still there and
	// nothing is lost; the other order could leave a deleted drawer free to be re-mined.
	if (drawer.sourceMessageId) {
		await tombstoneMessages(input.userId, [drawer.sourceMessageId], 'drawer_deleted')
	}
	await db
		.delete(memoryDrawers)
		.where(and(eq(memoryDrawers.id, input.drawerId), eq(memoryDrawers.userId, input.userId)))
	return true
}

export type ForgetConversationResult = {
	conversationId: string
	drawersDeleted: number
	closetsDeleted: number
	roomsDeleted: number
	wingsDeleted: number
}

/**
 * Delete everything mined from one conversation: every room tied to it, which cascades
 * through closets to drawers. Wings left with no rooms are removed too, so "forget this
 * conversation" does not leave an empty wing on the map.
 *
 * Every message the conversation holds right now is tombstoned first, so the next exchange's
 * mining run does not memorize it all again. Messages sent after this are mined as usual.
 */
export async function forgetConversationMemories(input: {
	userId: string
	conversationId: string
}): Promise<ForgetConversationResult> {
	const owned = await db
		.select({ id: messages.id })
		.from(messages)
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(and(eq(messages.conversationId, input.conversationId), eq(conversations.userId, input.userId)))
	await tombstoneMessages(
		input.userId,
		owned.map((row) => row.id),
		'conversation_forgotten',
	)

	const rooms = await db
		.select({ id: memoryRooms.id, wingId: memoryRooms.wingId })
		.from(memoryRooms)
		.innerJoin(memoryWings, eq(memoryWings.id, memoryRooms.wingId))
		.where(and(eq(memoryRooms.conversationId, input.conversationId), eq(memoryWings.userId, input.userId)))

	const result: ForgetConversationResult = {
		conversationId: input.conversationId,
		drawersDeleted: 0,
		closetsDeleted: 0,
		roomsDeleted: 0,
		wingsDeleted: 0,
	}
	if (rooms.length === 0) return result

	const roomIds = rooms.map((room) => room.id)
	const wingIds = [...new Set(rooms.map((room) => room.wingId))]

	const closets = await db
		.select({ id: memoryClosets.id })
		.from(memoryClosets)
		.where(inArray(memoryClosets.roomId, roomIds))
	const closetIds = closets.map((closet) => closet.id)

	if (closetIds.length > 0) {
		const [drawerCount] = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(memoryDrawers)
			.where(inArray(memoryDrawers.closetId, closetIds))
		result.drawersDeleted = drawerCount?.n ?? 0
	}
	result.closetsDeleted = closetIds.length

	// Rooms cascade to closets, which cascade to drawers.
	const deletedRooms = await db
		.delete(memoryRooms)
		.where(inArray(memoryRooms.id, roomIds))
		.returning({ id: memoryRooms.id })
	result.roomsDeleted = deletedRooms.length

	// Any wing that now has no rooms at all is dead weight on the map.
	for (const wingId of wingIds) {
		const [remaining] = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(memoryRooms)
			.where(eq(memoryRooms.wingId, wingId))
		if ((remaining?.n ?? 0) === 0) {
			const deleted = await db
				.delete(memoryWings)
				.where(and(eq(memoryWings.id, wingId), eq(memoryWings.userId, input.userId)))
				.returning({ id: memoryWings.id })
			result.wingsDeleted += deleted.length
		}
	}

	logger.info('[memory] forgot a conversation', result)
	return result
}

export type MinedConversationRow = {
	conversationId: string
	title: string | null
	roomCount: number
	drawerCount: number
	lastMinedAt: Date | null
}

/** Conversations that currently have memories in the palace, newest first. */
export async function listMinedConversations(userId: string, limit = 100): Promise<MinedConversationRow[]> {
	const rows = await db.execute<{
		conversation_id: string
		title: string | null
		room_count: number
		drawer_count: number
		last_mined_at: Date | null
	}>(sql`
		select
			r.conversation_id as conversation_id,
			max(c.title) as title,
			count(distinct r.id)::int as room_count,
			count(d.id)::int as drawer_count,
			max(d.created_at) as last_mined_at
		from ${memoryRooms} r
		inner join ${memoryWings} w on w.id = r.wing_id
		left join ${memoryClosets} cl on cl.room_id = r.id
		left join ${memoryDrawers} d on d.closet_id = cl.id
		left join ${conversations} c on c.id = r.conversation_id
		where w.user_id = ${userId} and r.conversation_id is not null
		group by r.conversation_id
		order by max(d.created_at) desc nulls last
		limit ${limit}
	`)

	return rows.map((row) => ({
		conversationId: row.conversation_id,
		title: row.title,
		roomCount: Number(row.room_count ?? 0),
		drawerCount: Number(row.drawer_count ?? 0),
		lastMinedAt: row.last_mined_at ? new Date(row.last_mined_at) : null,
	}))
}
