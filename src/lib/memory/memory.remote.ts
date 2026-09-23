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
	memoryExclusionRules,
	memoryKgEntities,
	memoryKgRelations,
	memoryRooms,
	memoryWings,
} from '$lib/memory/memory.schema'
import { listConversationsWithUnminedMessages, recallForUser } from '$lib/memory/memory.server'
import {
	deleteDrawer,
	editDrawerContent,
	forgetConversationMemories,
	listMinedConversations,
	setDrawerFlags,
	MAX_DRAWER_CONTENT_CHARS,
} from '$lib/memory/curation.server'
import {
	compileExclusionRules,
	ensureBuiltinExclusionRules,
	findExclusionMatch,
	MAX_PATTERN_LENGTH,
	validateExclusionPattern,
} from '$lib/memory/exclusions.server'
import { listDrawerRecallEvents } from '$lib/memory/recall-log.server'
import { messages, conversations } from '$lib/sessions/sessions.schema'
import { jobs } from '$lib/jobs/jobs.schema'
import { enqueueJobWithOutcome } from '$lib/jobs/jobs.server'
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
			pinned: memoryDrawers.pinned,
			neverRecall: memoryDrawers.neverRecall,
			editedAt: memoryDrawers.editedAt,
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
	return recallForUser(user.id, q, {
		topK: topK ?? 5,
		useRerank: useRerank ?? false,
		recallSource: 'search',
	})
})

export const deleteMemoryDrawerCommand = command(drawerIdSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	await deleteDrawer({ userId: user.id, drawerId: id })
	return { ok: true }
})

const editDrawerSchema = z.object({
	id: z.string().uuid(),
	content: z.string().trim().min(1).max(MAX_DRAWER_CONTENT_CHARS),
})

/**
 * Rewrite a mined paraphrase. Re-embeds in the same call; if embedding is unavailable the
 * vector is cleared rather than left pointing at the old wording, and the response says so
 * (`reEmbedded: false`) so the UI can warn that the drawer is out of semantic recall until
 * the next Reorganize backfill.
 */
export const editMemoryDrawerCommand = command(editDrawerSchema, async ({ id, content }) => {
	const user = requireAuthenticatedRequestUser()
	const result = await editDrawerContent({ userId: user.id, drawerId: id, content })
	if (!result.ok) {
		return { ok: false as const, reason: result.reason }
	}
	return {
		ok: true as const,
		reEmbedded: result.reEmbedded,
		embeddingError: 'embeddingError' in result ? result.embeddingError : undefined,
		tokenCount: result.tokenCount,
	}
})

const drawerFlagsSchema = z.object({
	id: z.string().uuid(),
	pinned: z.boolean().optional(),
	neverRecall: z.boolean().optional(),
})

/** Pin (always consider in recall) / never-recall (browsable, never injected) per drawer. */
export const setMemoryDrawerFlagsCommand = command(drawerFlagsSchema, async ({ id, pinned, neverRecall }) => {
	const user = requireAuthenticatedRequestUser()
	const result = await setDrawerFlags({ userId: user.id, drawerId: id, pinned, neverRecall })
	if (!result) return { ok: false as const }
	return { ok: true as const, pinned: result.pinned, neverRecall: result.neverRecall }
})

const conversationIdSchema = z.object({ conversationId: z.string().uuid() })

/** Delete everything mined from one conversation — rooms, closets, drawers, empty wings. */
export const forgetConversationMemoriesCommand = command(conversationIdSchema, async ({ conversationId }) => {
	const user = requireAuthenticatedRequestUser()
	return forgetConversationMemories({ userId: user.id, conversationId })
})

/** Conversations that currently have memories, for the "forget a conversation" list. */
export const listMinedConversationsQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return listMinedConversations(user.id)
})

export const listDrawerRecallEventsQuery = query(drawerIdSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	return listDrawerRecallEvents(user.id, id)
})

/* ------------------------------------------------------------------ exclusion rules */

export const listMemoryExclusionRulesQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	await ensureBuiltinExclusionRules(user.id)
	return db
		.select({
			id: memoryExclusionRules.id,
			name: memoryExclusionRules.name,
			description: memoryExclusionRules.description,
			kind: memoryExclusionRules.kind,
			pattern: memoryExclusionRules.pattern,
			enabled: memoryExclusionRules.enabled,
			builtin: memoryExclusionRules.builtin,
			hitCount: memoryExclusionRules.hitCount,
			lastHitAt: memoryExclusionRules.lastHitAt,
		})
		.from(memoryExclusionRules)
		.where(eq(memoryExclusionRules.userId, user.id))
		.orderBy(desc(memoryExclusionRules.builtin), memoryExclusionRules.name)
})

const saveExclusionRuleSchema = z.object({
	id: z.string().uuid().optional(),
	name: z.string().trim().min(1).max(80),
	description: z.string().trim().max(240).optional(),
	kind: z.enum(['regex', 'substring']),
	pattern: z.string().trim().min(1).max(MAX_PATTERN_LENGTH),
	enabled: z.boolean().default(true),
})

export const saveMemoryExclusionRuleCommand = command(saveExclusionRuleSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const invalid = validateExclusionPattern(input.kind, input.pattern)
	if (invalid) return { ok: false as const, error: invalid }

	if (input.id) {
		const [updated] = await db
			.update(memoryExclusionRules)
			.set({
				name: input.name,
				description: input.description ?? null,
				kind: input.kind,
				pattern: input.pattern,
				enabled: input.enabled,
				updatedAt: new Date(),
			})
			.where(and(eq(memoryExclusionRules.id, input.id), eq(memoryExclusionRules.userId, user.id)))
			.returning({ id: memoryExclusionRules.id })
		if (!updated) return { ok: false as const, error: 'Rule not found.' }
		return { ok: true as const, id: updated.id }
	}

	try {
		const [created] = await db
			.insert(memoryExclusionRules)
			.values({
				userId: user.id,
				name: input.name,
				description: input.description ?? null,
				kind: input.kind,
				pattern: input.pattern,
				enabled: input.enabled,
				builtin: false,
			})
			.returning({ id: memoryExclusionRules.id })
		return { ok: true as const, id: created.id }
	} catch {
		return { ok: false as const, error: 'A rule with that name already exists.' }
	}
})

const exclusionRuleIdSchema = z.object({ id: z.string().uuid() })

/** Built-in credential rules can be disabled but never deleted. */
export const deleteMemoryExclusionRuleCommand = command(exclusionRuleIdSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	const [row] = await db
		.select({ builtin: memoryExclusionRules.builtin })
		.from(memoryExclusionRules)
		.where(and(eq(memoryExclusionRules.id, id), eq(memoryExclusionRules.userId, user.id)))
		.limit(1)
	if (!row) return { ok: false as const, error: 'Rule not found.' }
	if (row.builtin) return { ok: false as const, error: 'Built-in rules can be disabled but not deleted.' }
	await db
		.delete(memoryExclusionRules)
		.where(and(eq(memoryExclusionRules.id, id), eq(memoryExclusionRules.userId, user.id)))
	return { ok: true as const }
})

export const toggleMemoryExclusionRuleCommand = command(
	z.object({ id: z.string().uuid(), enabled: z.boolean() }),
	async ({ id, enabled }) => {
		const user = requireAuthenticatedRequestUser()
		await db
			.update(memoryExclusionRules)
			.set({ enabled, updatedAt: new Date() })
			.where(and(eq(memoryExclusionRules.id, id), eq(memoryExclusionRules.userId, user.id)))
		return { ok: true as const }
	},
)

/**
 * Dry-run the live rule set against sample text. Lets a user check a new pattern before
 * trusting it with their secrets — and check that an existing rule catches what they think.
 */
export const testMemoryExclusionRulesQuery = query(
	z.object({ sample: z.string().max(4000) }),
	async ({ sample }) => {
		const user = requireAuthenticatedRequestUser()
		if (sample.trim().length === 0) return { matched: false as const }
		const rows = await db
			.select({
				id: memoryExclusionRules.id,
				name: memoryExclusionRules.name,
				kind: memoryExclusionRules.kind,
				pattern: memoryExclusionRules.pattern,
				enabled: memoryExclusionRules.enabled,
			})
			.from(memoryExclusionRules)
			.where(and(eq(memoryExclusionRules.userId, user.id), eq(memoryExclusionRules.enabled, true)))
		const match = findExclusionMatch(sample, compileExclusionRules(rows))
		if (!match) return { matched: false as const }
		return { matched: true as const, ruleName: match.ruleName, sample: match.sample }
	},
)

/**
 * Manual "Mine pending" — enqueues a `memory_mine` job for every conversation of the caller's
 * that still holds a message the miner would pick up (no drawer, no tombstone). The
 * `mine:<conversationId>` dedupe key collapses onto a mining job already queued for that
 * conversation, and `mineConversation` only mines what is new — so this is safe to spam.
 *
 * `enqueued` counts jobs this call actually created; a conversation whose mining job was
 * already queued counts under `alreadyQueued`, not as new work.
 */
export const mineAllPendingCommand = command(async () => {
	const user = requireAuthenticatedRequestUser()

	const [{ scanned }] = await db
		.select({ scanned: countDistinct(conversations.id) })
		.from(conversations)
		.innerJoin(messages, eq(messages.conversationId, conversations.id))
		.where(eq(conversations.userId, user.id))
	const pending = await listConversationsWithUnminedMessages(user.id)

	let enqueued = 0
	let alreadyQueued = 0
	let skipped = 0
	for (const conversationId of pending) {
		try {
			const { created } = await enqueueJobWithOutcome({
				type: 'memory_mine',
				queue: 'default',
				priority: 75,
				dedupeKey: `mine:${conversationId}`,
				payload: { conversationId },
				userId: user.id,
				sessionId: conversationId,
			})
			if (created) enqueued += 1
			else alreadyQueued += 1
		} catch {
			skipped += 1
		}
	}

	return {
		conversationsScanned: scanned,
		alreadyMined: scanned - pending.length,
		enqueued,
		alreadyQueued,
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
			pinned: memoryDrawers.pinned,
			neverRecall: memoryDrawers.neverRecall,
			editedAt: memoryDrawers.editedAt,
			hasEmbedding: sql<boolean>`${memoryDrawers.embedding} is not null`,
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

	// Why was this recalled? — the component scores recall already computed, kept per event.
	const recall = await listDrawerRecallEvents(user.id, id)

	return {
		...row,
		sourceMessage,
		kgRelations: kgRows,
		recallEvents: recall.events,
		recallCount: recall.total,
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
export type MemoryExclusionRuleRow = Awaited<ReturnType<typeof listMemoryExclusionRulesQuery>>[number]
export type MemoryMinedConversationRow = Awaited<ReturnType<typeof listMinedConversationsQuery>>[number]
export type MemoryRecallEventRow = MemoryDrawerDetail['recallEvents'][number]
