/**
 * Hybrid retrieval — semantic + keyword + temporal proximity.
 *
 * Ported from MemPalace's `searcher.py`. Pipeline:
 *   1. Cosine similarity top-N via pgvector `<=>`.
 *   2. Keyword (BM25-ish) boost via Postgres tsvector `@@`.
 *   3. Temporal proximity boost using `question_date` vs drawer.occurredAt.
 *   4. Optional preference-pattern boost (last-mentioned wins).
 *
 * User control (issue #37):
 *   - drawers flagged `never_recall` are excluded from the candidate pool entirely;
 *   - drawers flagged `pinned` are force-added to the pool even when they fall outside
 *     the vector top-N, and receive a configurable additive boost.
 *
 * Returns ranked drawer rows joined back to room/closet/wing for context, each carrying
 * its component scores so a bad recall can be explained after the fact.
 */

import { and, eq, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations } from '$lib/sessions/sessions.schema'
import { memoryClosets, memoryDrawers, memoryRooms, memoryWings } from '$lib/memory/memory.schema'
import { embedOne, toPgVector } from '$lib/memory/embeddings.server'

export type RetrievedDrawer = {
	drawerId: string
	roomId: string
	closetId: string
	wingId: string
	content: string
	role: 'user' | 'assistant' | 'system' | 'note'
	occurredAt: Date
	conversationId: string | null
	wingName: string
	roomLabel: string
	closetTopic: string
	pinned: boolean
	semanticScore: number
	keywordScore: number
	temporalScore: number
	/** Additive boost applied because the drawer is pinned (0 when it is not). */
	pinnedBoost: number
	finalScore: number
}

export type RecallOptions = {
	topK?: number
	candidatePoolSize?: number
	semanticWeight?: number
	keywordWeight?: number
	temporalWeight?: number
	queryDate?: Date
	temporalDecayDays?: number
	preferenceBoost?: boolean
	/** Additive score bonus for pinned drawers. */
	pinnedBoost?: number
	/** Cap on how many pinned drawers are force-added to the candidate pool. */
	pinnedPoolSize?: number
}

export const RECALL_DEFAULTS = {
	topK: 5,
	candidatePoolSize: 50,
	semanticWeight: 1,
	keywordWeight: 0.35,
	temporalWeight: 0.25,
	temporalDecayDays: 30,
	preferenceBoost: true,
	pinnedBoost: 0.15,
	pinnedPoolSize: 25,
}

const DEFAULTS = RECALL_DEFAULTS

function temporalScore(occurredAt: Date, queryDate: Date | undefined, decayDays: number): number {
	if (!queryDate) return 0
	const deltaDays = Math.abs(queryDate.getTime() - occurredAt.getTime()) / (1000 * 60 * 60 * 24)
	// proximity in [0,1]: exp(-delta/decay)
	return Math.exp(-deltaDays / Math.max(1, decayDays))
}

function buildTsQuery(query: string): string {
	// Naive tokenizer: split on whitespace, drop short tokens, OR-join.
	const tokens = query
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((token) => token.length >= 3)
	if (tokens.length === 0) return ''
	return tokens.map((token) => `${token}:*`).join(' | ')
}

export async function recall(userId: string, query: string, options: RecallOptions = {}): Promise<RetrievedDrawer[]> {
	const opts = { ...DEFAULTS, ...options }
	// The query is the user's message as typed: embedded once, so there is nothing to gain from
	// asking OpenRouter to keep it for a day.
	const queryEmbedding = await embedOne(query, { cache: false })
	const vec = toPgVector(queryEmbedding)
	const tsQuery = buildTsQuery(query)

	// pgvector cosine distance: smaller is closer. Convert to similarity (1 - distance).
	const semanticExpr = sql<number>`1 - (${memoryDrawers.embedding} <=> ${vec}::vector)`
	const keywordExpr = tsQuery
		? sql<number>`coalesce(ts_rank(to_tsvector('english', ${memoryDrawers.content}), to_tsquery('english', ${tsQuery})), 0)`
		: sql<number>`0`

	const selection = {
		drawerId: memoryDrawers.id,
		roomId: memoryRooms.id,
		closetId: memoryClosets.id,
		wingId: memoryWings.id,
		content: memoryDrawers.content,
		role: memoryDrawers.role,
		occurredAt: memoryDrawers.occurredAt,
		conversationId: memoryRooms.conversationId,
		wingName: memoryWings.name,
		roomLabel: memoryRooms.label,
		closetTopic: memoryClosets.topic,
		pinned: memoryDrawers.pinned,
		semantic: semanticExpr,
		keyword: keywordExpr,
	}

	// `never_recall` drawers stay visible in the palace but are hard-excluded here: the
	// filter lives in the candidate query so they can never reach a prompt.
	const recallable = and(
		eq(memoryDrawers.userId, userId),
		eq(memoryDrawers.neverRecall, false),
		sql`${memoryDrawers.embedding} IS NOT NULL`,
	)

	const rows = await db
		.select(selection)
		.from(memoryDrawers)
		.innerJoin(memoryClosets, eq(memoryClosets.id, memoryDrawers.closetId))
		.innerJoin(memoryRooms, eq(memoryRooms.id, memoryClosets.roomId))
		.innerJoin(memoryWings, eq(memoryWings.id, memoryRooms.wingId))
		.where(recallable)
		.orderBy(sql`${memoryDrawers.embedding} <=> ${vec}::vector`)
		.limit(opts.candidatePoolSize)

	// Pinned drawers are the user saying "always consider this". A boost alone would not
	// deliver that, because a drawer outside the vector top-N never enters the pool at
	// all — so fetch them explicitly and merge.
	const pinnedRows =
		opts.pinnedPoolSize > 0
			? await db
					.select(selection)
					.from(memoryDrawers)
					.innerJoin(memoryClosets, eq(memoryClosets.id, memoryDrawers.closetId))
					.innerJoin(memoryRooms, eq(memoryRooms.id, memoryClosets.roomId))
					.innerJoin(memoryWings, eq(memoryWings.id, memoryRooms.wingId))
					.where(and(recallable, eq(memoryDrawers.pinned, true)))
					.orderBy(sql`${memoryDrawers.embedding} <=> ${vec}::vector`)
					.limit(opts.pinnedPoolSize)
			: []

	const seen = new Set(rows.map((row) => row.drawerId))
	const candidates = [...rows]
	for (const row of pinnedRows) {
		if (seen.has(row.drawerId)) continue
		seen.add(row.drawerId)
		candidates.push(row)
	}

	const scored: RetrievedDrawer[] = candidates.map((row) => {
		const semantic = Number(row.semantic ?? 0)
		const keyword = Number(row.keyword ?? 0)
		const temporal = temporalScore(row.occurredAt, opts.queryDate, opts.temporalDecayDays)
		const pinnedBoost = row.pinned ? opts.pinnedBoost : 0
		const finalScore =
			opts.semanticWeight * semantic + opts.keywordWeight * keyword + opts.temporalWeight * temporal + pinnedBoost
		return {
			drawerId: row.drawerId,
			roomId: row.roomId,
			closetId: row.closetId,
			wingId: row.wingId,
			content: row.content,
			role: row.role,
			occurredAt: row.occurredAt,
			conversationId: row.conversationId,
			wingName: row.wingName,
			roomLabel: row.roomLabel,
			closetTopic: row.closetTopic,
			pinned: row.pinned,
			semanticScore: semantic,
			keywordScore: keyword,
			temporalScore: temporal,
			pinnedBoost,
			finalScore,
		}
	})

	// Optional preference-pattern boost: when multiple drawers share the same closet
	// topic and represent stated preferences, the most recent wins. We approximate
	// this by adding a small recency tiebreaker within the same closet+role.
	if (opts.preferenceBoost) {
		const seenLatest = new Map<string, number>()
		for (const drawer of scored) {
			const key = `${drawer.closetId}:${drawer.role}`
			seenLatest.set(key, Math.max(seenLatest.get(key) ?? 0, drawer.occurredAt.getTime()))
		}
		for (const drawer of scored) {
			const key = `${drawer.closetId}:${drawer.role}`
			if (seenLatest.get(key) === drawer.occurredAt.getTime()) {
				drawer.finalScore += 0.05
			}
		}
	}

	scored.sort((a, b) => b.finalScore - a.finalScore)
	return scored.slice(0, opts.topK)
}

/** Group retrieved drawers back into source chat sessions for benchmark scoring. */
export async function recallSessions(
	userId: string,
	query: string,
	options: RecallOptions = {},
): Promise<{ conversationId: string; drawers: RetrievedDrawer[] }[]> {
	const drawers = await recall(userId, query, { ...options, topK: options.topK ?? 5 })
	const grouped = new Map<string, RetrievedDrawer[]>()
	for (const drawer of drawers) {
		const key = drawer.conversationId ?? `room:${drawer.roomId}`
		const arr = grouped.get(key) ?? []
		arr.push(drawer)
		grouped.set(key, arr)
	}
	return [...grouped.entries()].map(([conversationId, list]) => ({ conversationId, drawers: list }))
}

/** Resolve a conversation id back to its `conversations` row label (best-effort). */
export async function resolveConversationLabel(conversationId: string): Promise<string | null> {
	if (!conversationId) return null
	const [row] = await db
		.select({ title: conversations.title })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1)
	return row?.title ?? null
}
