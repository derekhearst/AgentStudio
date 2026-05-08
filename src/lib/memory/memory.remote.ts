/**
 * SvelteKit remote queries/commands for the memory palace UI.
 */

import { command, query } from '$app/server'
import { z } from 'zod'
import { and, count, countDistinct, desc, eq, inArray, max, sql, sum } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import {
	memoryClosets,
	memoryDrawers,
	memoryKgEntities,
	memoryKgRelations,
	memoryRooms,
	memoryWings,
} from '$lib/memory/memory.schema'
import { recallForUser } from '$lib/memory/memory.server'
import { messages, conversations } from '$lib/sessions/sessions.schema'
import { artifacts } from '$lib/projects/projects.schema'
import { jobs } from '$lib/jobs/jobs.schema'
import { enqueueJob } from '$lib/jobs/jobs.server'
import { analyzeReorganization, applyReorganization } from '$lib/memory/reorganize.server'

export type MemoryDrawerAaak = {
	pointer: string
	tags: { p?: string[]; l?: string[]; e?: string[]; i?: string[]; t?: string[] }
}

const searchSchema = z.object({
	query: z.string().trim().min(1).max(2000),
	topK: z.number().int().min(1).max(20).optional(),
	useRerank: z.boolean().optional(),
})

const drawerIdSchema = z.object({ id: z.string().uuid() })

export const listMemoryWingsQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	const rows = await db
		.select({
			id: memoryWings.id,
			name: memoryWings.name,
			kind: memoryWings.kind,
			aliases: memoryWings.aliases,
			summary: memoryWings.summary,
			updatedAt: memoryWings.updatedAt,
			roomCount: sql<number>`coalesce((select count(*)::int from memory_rooms where memory_rooms.wing_id = memory_wings.id), 0)`,
			drawerCount: sql<number>`coalesce((
				select count(*)::int from memory_drawers
				inner join memory_closets on memory_closets.id = memory_drawers.closet_id
				inner join memory_rooms on memory_rooms.id = memory_closets.room_id
				where memory_rooms.wing_id = memory_wings.id
			), 0)`,
			lastTouchedAt: sql<string | null>`(
				select max(memory_drawers.occurred_at) from memory_drawers
				inner join memory_closets on memory_closets.id = memory_drawers.closet_id
				inner join memory_rooms on memory_rooms.id = memory_closets.room_id
				where memory_rooms.wing_id = memory_wings.id
			)`,
		})
		.from(memoryWings)
		.where(eq(memoryWings.userId, user.id))
		.orderBy(memoryWings.name)
	return rows
})

const wingIdSchema = z.object({ wingId: z.string().uuid() })

export const listMemoryRoomsQuery = query(wingIdSchema, async ({ wingId }) => {
	const user = requireAuthenticatedRequestUser()
	const [wing] = await db
		.select({ id: memoryWings.id })
		.from(memoryWings)
		.where(and(eq(memoryWings.id, wingId), eq(memoryWings.userId, user.id)))
		.limit(1)
	if (!wing) return []
	return db
		.select({
			id: memoryRooms.id,
			label: memoryRooms.label,
			summary: memoryRooms.summary,
			occurredAt: memoryRooms.occurredAt,
			conversationId: memoryRooms.conversationId,
			closetCount: sql<number>`coalesce((select count(*)::int from memory_closets where memory_closets.room_id = memory_rooms.id), 0)`,
			drawerCount: sql<number>`coalesce((
				select count(*)::int from memory_drawers
				inner join memory_closets on memory_closets.id = memory_drawers.closet_id
				where memory_closets.room_id = memory_rooms.id
			), 0)`,
		})
		.from(memoryRooms)
		.where(eq(memoryRooms.wingId, wingId))
		.orderBy(desc(memoryRooms.occurredAt))
})

const roomIdSchema = z.object({ roomId: z.string().uuid() })

export const listMemoryClosetsQuery = query(roomIdSchema, async ({ roomId }) => {
	const user = requireAuthenticatedRequestUser()
	// IDOR fix: verify the room rolls up to a wing the caller owns.
	const [owned] = await db
		.select({ id: memoryRooms.id })
		.from(memoryRooms)
		.innerJoin(memoryWings, eq(memoryWings.id, memoryRooms.wingId))
		.where(and(eq(memoryRooms.id, roomId), eq(memoryWings.userId, user.id)))
		.limit(1)
	if (!owned) return []
	return db
		.select({
			id: memoryClosets.id,
			topic: memoryClosets.topic,
			summary: memoryClosets.summary,
			drawerCount: sql<number>`coalesce((select count(*)::int from memory_drawers where memory_drawers.closet_id = memory_closets.id), 0)`,
		})
		.from(memoryClosets)
		.where(eq(memoryClosets.roomId, roomId))
})

const closetIdSchema = z.object({ closetId: z.string().uuid() })

export const listMemoryDrawersQuery = query(closetIdSchema, async ({ closetId }) => {
	const user = requireAuthenticatedRequestUser()
	// IDOR fix: verify the closet rolls up to a wing the caller owns.
	const [owned] = await db
		.select({ id: memoryClosets.id })
		.from(memoryClosets)
		.innerJoin(memoryRooms, eq(memoryRooms.id, memoryClosets.roomId))
		.innerJoin(memoryWings, eq(memoryWings.id, memoryRooms.wingId))
		.where(and(eq(memoryClosets.id, closetId), eq(memoryWings.userId, user.id)))
		.limit(1)
	if (!owned) return []
	return db
		.select({
			id: memoryDrawers.id,
			role: memoryDrawers.role,
			content: memoryDrawers.content,
			aaak: memoryDrawers.aaak,
			tokenCount: memoryDrawers.tokenCount,
			occurredAt: memoryDrawers.occurredAt,
			sourceMessageId: memoryDrawers.sourceMessageId,
			linkedArtifactId: memoryDrawers.linkedArtifactId,
			sourceExcerpt: sql<string | null>`(
				select substring(messages.content from 1 for 120) from messages
				where messages.id = memory_drawers.source_message_id
			)`,
		})
		.from(memoryDrawers)
		.where(and(eq(memoryDrawers.closetId, closetId), eq(memoryDrawers.userId, user.id)))
		.orderBy(memoryDrawers.occurredAt)
		.limit(50)
})

export const searchMemoryQuery = query(searchSchema, async ({ query: q, topK, useRerank }) => {
	const user = requireAuthenticatedRequestUser()
	return recallForUser(user.id, q, { topK: topK ?? 5, useRerank: useRerank ?? false })
})

export const deleteMemoryDrawerCommand = command(drawerIdSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	await db.delete(memoryDrawers).where(and(eq(memoryDrawers.id, id), eq(memoryDrawers.userId, user.id)))
	return { ok: true }
})

/**
 * Manual reorganize trigger — finds every conversation owned by the caller that has at
 * least one message but is not yet represented in the palace (no room rolls up to it),
 * and enqueues a `memory_mine` job for each. The job's `mine:<conversationId>` dedupe
 * key collapses repeats with anything already in flight, and `mineConversation` skips
 * messages that already have a drawer — so this is safe to spam.
 */
export const mineAllPendingCommand = command(async () => {
	const user = requireAuthenticatedRequestUser()

	// All conversations owned by the user that already contain at least one message.
	const candidates = await db
		.selectDistinct({ id: conversations.id })
		.from(conversations)
		.innerJoin(messages, eq(messages.conversationId, conversations.id))
		.where(eq(conversations.userId, user.id))

	// Conversations that already have a room — these are "covered". We re-enqueue them
	// anyway because new messages may have arrived after the last mine; mineConversation
	// skips already-mined messages so this is cheap.
	const covered = new Set<string>()
	if (candidates.length > 0) {
		const rows = await db
			.select({ conversationId: memoryRooms.conversationId })
			.from(memoryRooms)
			.innerJoin(memoryWings, eq(memoryWings.id, memoryRooms.wingId))
			.where(
				and(
					eq(memoryWings.userId, user.id),
					inArray(
						memoryRooms.conversationId,
						candidates.map((c) => c.id),
					),
				),
			)
		for (const row of rows) {
			if (row.conversationId) covered.add(row.conversationId)
		}
	}

	let enqueued = 0
	let skipped = 0
	for (const candidate of candidates) {
		try {
			await enqueueJob({
				type: 'memory_mine',
				queue: 'default',
				priority: 75,
				dedupeKey: `mine:${candidate.id}`,
				payload: { conversationId: candidate.id },
				userId: user.id,
				sessionId: candidate.id,
			})
			enqueued += 1
		} catch {
			skipped += 1
		}
	}

	return {
		conversationsScanned: candidates.length,
		alreadyMined: covered.size,
		enqueued,
		skipped,
	}
})

export const getMemoryStatsQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	const [wingsCount] = await db
		.select({ n: count() })
		.from(memoryWings)
		.where(eq(memoryWings.userId, user.id))
	const [drawerAgg] = await db
		.select({
			n: count(),
			tokens: sum(memoryDrawers.tokenCount),
			lastMined: max(memoryDrawers.createdAt),
		})
		.from(memoryDrawers)
		.where(eq(memoryDrawers.userId, user.id))
	const [drawersWithEmbedding] = await db
		.select({ n: count() })
		.from(memoryDrawers)
		.where(and(eq(memoryDrawers.userId, user.id), sql`${memoryDrawers.embedding} is not null`))
	const [roomAgg] = await db
		.select({ n: countDistinct(memoryRooms.id), lastTouched: max(memoryDrawers.occurredAt) })
		.from(memoryDrawers)
		.innerJoin(memoryClosets, eq(memoryClosets.id, memoryDrawers.closetId))
		.innerJoin(memoryRooms, eq(memoryRooms.id, memoryClosets.roomId))
		.where(eq(memoryDrawers.userId, user.id))

	// Conversation coverage: how many of the user's conversations have at least one drawer.
	const [convoCount] = await db
		.select({ n: count() })
		.from(conversations)
		.where(eq(conversations.userId, user.id))
	const [minedConvoCount] = await db
		.select({ n: countDistinct(memoryRooms.conversationId) })
		.from(memoryRooms)
		.innerJoin(memoryWings, eq(memoryWings.id, memoryRooms.wingId))
		.where(and(eq(memoryWings.userId, user.id), sql`${memoryRooms.conversationId} is not null`))

	// Pending mining jobs (still queued or running) for this user.
	const [pendingMine] = await db
		.select({ n: count() })
		.from(jobs)
		.where(
			and(
				eq(jobs.type, 'memory_mine'),
				eq(jobs.userId, user.id),
				inArray(jobs.status, ['pending', 'leased', 'running', 'retry_wait']),
			),
		)

	const drawerN = drawerAgg?.n ?? 0
	const embeddedN = drawersWithEmbedding?.n ?? 0

	return {
		wingCount: wingsCount?.n ?? 0,
		drawerCount: drawerN,
		tokenSum: Number(drawerAgg?.tokens ?? 0),
		roomCount: roomAgg?.n ?? 0,
		lastTouchedAt: roomAgg?.lastTouched ?? null,
		lastMinedAt: drawerAgg?.lastMined ?? null,
		conversationCount: convoCount?.n ?? 0,
		minedConversationCount: minedConvoCount?.n ?? 0,
		drawersWithEmbedding: embeddedN,
		embeddingCoverage: drawerN === 0 ? 1 : embeddedN / drawerN,
		pendingMineJobs: pendingMine?.n ?? 0,
	}
})

export const getMemoryDrawerQuery = query(drawerIdSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	const [row] = await db
		.select({
			id: memoryDrawers.id,
			closetId: memoryDrawers.closetId,
			role: memoryDrawers.role,
			content: memoryDrawers.content,
			aaak: memoryDrawers.aaak,
			tokenCount: memoryDrawers.tokenCount,
			occurredAt: memoryDrawers.occurredAt,
			createdAt: memoryDrawers.createdAt,
			sourceMessageId: memoryDrawers.sourceMessageId,
			linkedArtifactId: memoryDrawers.linkedArtifactId,
			closetTopic: memoryClosets.topic,
			roomId: memoryRooms.id,
			roomLabel: memoryRooms.label,
			conversationId: memoryRooms.conversationId,
			conversationTitle: conversations.title,
			wingId: memoryWings.id,
			wingName: memoryWings.name,
			wingKind: memoryWings.kind,
		})
		.from(memoryDrawers)
		.innerJoin(memoryClosets, eq(memoryClosets.id, memoryDrawers.closetId))
		.innerJoin(memoryRooms, eq(memoryRooms.id, memoryClosets.roomId))
		.innerJoin(memoryWings, eq(memoryWings.id, memoryRooms.wingId))
		.leftJoin(conversations, eq(conversations.id, memoryRooms.conversationId))
		.where(and(eq(memoryDrawers.id, id), eq(memoryWings.userId, user.id)))
		.limit(1)
	if (!row) return null

	let sourceMessage: { id: string; role: string; content: string } | null = null
	if (row.sourceMessageId) {
		const [m] = await db
			.select({ id: messages.id, role: messages.role, content: messages.content })
			.from(messages)
			.where(eq(messages.id, row.sourceMessageId))
			.limit(1)
		sourceMessage = m ?? null
	}

	let linkedArtifact: { id: string; name: string } | null = null
	if (row.linkedArtifactId) {
		const [a] = await db
			.select({ id: artifacts.id, name: artifacts.name })
			.from(artifacts)
			.where(eq(artifacts.id, row.linkedArtifactId))
			.limit(1)
		linkedArtifact = a ?? null
	}

	const kgRows = await db
		.select({
			relationId: memoryKgRelations.id,
			relation: memoryKgRelations.relation,
			fromName: sql<string>`from_e.name`,
			toName: sql<string>`to_e.name`,
		})
		.from(memoryKgRelations)
		.innerJoin(sql`${memoryKgEntities} as from_e`, sql`from_e.id = ${memoryKgRelations.fromEntityId}`)
		.innerJoin(sql`${memoryKgEntities} as to_e`, sql`to_e.id = ${memoryKgRelations.toEntityId}`)
		.where(and(eq(memoryKgRelations.userId, user.id), eq(memoryKgRelations.sourceDrawerId, id)))

	return {
		...row,
		sourceMessage,
		linkedArtifact,
		kgRelations: kgRows,
	}
})

export const listMemoryWingEdgesQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	// Build edges between wings whose drawers reference the same KG entity.
	// Use a self-join on memory_kg_relations grouped by entity, falling back to
	// shared conversations when the KG is sparse.
	const kgEdges = await db.execute<{ a: string; b: string; weight: number }>(sql`
		select
			least(w1.id, w2.id) as a,
			greatest(w1.id, w2.id) as b,
			count(distinct r1.from_entity_id)::int as weight
		from ${memoryKgRelations} r1
		inner join ${memoryDrawers} d1 on d1.id = r1.source_drawer_id
		inner join ${memoryClosets} c1 on c1.id = d1.closet_id
		inner join ${memoryRooms} ro1 on ro1.id = c1.room_id
		inner join ${memoryWings} w1 on w1.id = ro1.wing_id
		inner join ${memoryKgRelations} r2 on r2.from_entity_id = r1.from_entity_id and r2.id <> r1.id
		inner join ${memoryDrawers} d2 on d2.id = r2.source_drawer_id
		inner join ${memoryClosets} c2 on c2.id = d2.closet_id
		inner join ${memoryRooms} ro2 on ro2.id = c2.room_id
		inner join ${memoryWings} w2 on w2.id = ro2.wing_id
		where w1.user_id = ${user.id} and w2.user_id = ${user.id} and w1.id <> w2.id
		group by least(w1.id, w2.id), greatest(w1.id, w2.id)
		having count(distinct r1.from_entity_id) >= 1
		order by weight desc
		limit 200
	`)

	if (kgEdges.length > 0) return kgEdges as Array<{ a: string; b: string; weight: number }>

	// Fallback: shared conversations.
	const convoEdges = await db.execute<{ a: string; b: string; weight: number }>(sql`
		select
			least(r1.wing_id, r2.wing_id) as a,
			greatest(r1.wing_id, r2.wing_id) as b,
			count(distinct r1.conversation_id)::int as weight
		from ${memoryRooms} r1
		inner join ${memoryRooms} r2 on r2.conversation_id = r1.conversation_id and r2.wing_id <> r1.wing_id
		inner join ${memoryWings} w1 on w1.id = r1.wing_id
		inner join ${memoryWings} w2 on w2.id = r2.wing_id
		where r1.conversation_id is not null
			and w1.user_id = ${user.id} and w2.user_id = ${user.id}
		group by least(r1.wing_id, r2.wing_id), greatest(r1.wing_id, r2.wing_id)
		order by weight desc
		limit 200
	`)
	return convoEdges as Array<{ a: string; b: string; weight: number }>
})

export const analyzeMemoryReorganizationQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return analyzeReorganization(user.id)
})

export const applyMemoryReorganizationCommand = command(async () => {
	const user = requireAuthenticatedRequestUser()
	return applyReorganization(user.id)
})

export type MemoryReorganizePlan = Awaited<ReturnType<typeof analyzeMemoryReorganizationQuery>>
export type MemoryReorganizeResult = Awaited<ReturnType<typeof applyMemoryReorganizationCommand>>

export type MemoryWingRow = Awaited<ReturnType<typeof listMemoryWingsQuery>>[number]
export type MemoryRoomRow = Awaited<ReturnType<typeof listMemoryRoomsQuery>>[number]
export type MemoryClosetRow = Awaited<ReturnType<typeof listMemoryClosetsQuery>>[number]
export type MemoryDrawerRow = Awaited<ReturnType<typeof listMemoryDrawersQuery>>[number]
export type MemoryDrawerDetail = NonNullable<Awaited<ReturnType<typeof getMemoryDrawerQuery>>>
export type MemoryStats = Awaited<ReturnType<typeof getMemoryStatsQuery>>
export type MemoryWingEdge = Awaited<ReturnType<typeof listMemoryWingEdgesQuery>>[number]
