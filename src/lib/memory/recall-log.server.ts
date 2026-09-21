/**
 * Recall provenance log — "why was this recalled?"
 *
 * `retrieval.server.ts` already computes semantic / keyword / temporal components and the
 * pinned boost for every drawer it returns. Those numbers are the only way to debug a bad
 * recall, and they were previously thrown away the moment the `<memory_context>` block was
 * rendered. This module persists them per drawer so the palace UI can explain, after the
 * fact, exactly why a drawer showed up.
 *
 * Writes are best-effort: recall is on the chat hot path and must never fail because the
 * audit insert did.
 */

import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { memoryRecallEvents } from '$lib/memory/memory.schema'
import type { RetrievedDrawer } from '$lib/memory/retrieval.server'
import { logger } from '$lib/observability/logger'

export type RecallSource = 'chat' | 'agent' | 'search' | 'bench'

/** Stored query text is capped — the log is for debugging, not a transcript. */
const MAX_QUERY_CHARS = 500
/** Events older than this are pruned opportunistically. */
const RETENTION_DAYS = 30
/** Fraction of recalls that also run the retention sweep. */
const PRUNE_PROBABILITY = 0.02

export async function recordRecallEvents(input: {
	userId: string
	query: string
	source: RecallSource
	drawers: RetrievedDrawer[]
	weights: { semantic: number; keyword: number; temporal: number }
}): Promise<void> {
	if (input.drawers.length === 0) return
	try {
		await db.insert(memoryRecallEvents).values(
			input.drawers.map((drawer, index) => ({
				userId: input.userId,
				drawerId: drawer.drawerId,
				query: input.query.slice(0, MAX_QUERY_CHARS),
				source: input.source,
				rank: index + 1,
				semanticScore: drawer.semanticScore,
				keywordScore: drawer.keywordScore,
				temporalScore: drawer.temporalScore,
				pinnedBoost: drawer.pinnedBoost,
				finalScore: drawer.finalScore,
				weights: input.weights,
			})),
		)
	} catch (error) {
		logger.warn('[memory] failed to record recall provenance', { err: error })
		return
	}

	if (Math.random() < PRUNE_PROBABILITY) {
		await pruneRecallEvents(input.userId).catch((error) => {
			logger.warn('[memory] recall log prune failed', { err: error })
		})
	}
}

/** Drop recall events older than the retention window for one user. */
export async function pruneRecallEvents(userId: string): Promise<number> {
	const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
	const deleted = await db
		.delete(memoryRecallEvents)
		.where(and(eq(memoryRecallEvents.userId, userId), lt(memoryRecallEvents.createdAt, cutoff)))
		.returning({ id: memoryRecallEvents.id })
	return deleted.length
}

export type DrawerRecallEvent = {
	id: string
	query: string
	source: RecallSource
	rank: number
	semanticScore: number
	keywordScore: number
	temporalScore: number
	pinnedBoost: number
	finalScore: number
	weights: { semantic: number; keyword: number; temporal: number } | null
	createdAt: Date
}

/** Most recent recalls that surfaced this drawer, newest first. */
export async function listDrawerRecallEvents(
	userId: string,
	drawerId: string,
	limit = 8,
): Promise<{ events: DrawerRecallEvent[]; total: number }> {
	const events = await db
		.select({
			id: memoryRecallEvents.id,
			query: memoryRecallEvents.query,
			source: memoryRecallEvents.source,
			rank: memoryRecallEvents.rank,
			semanticScore: memoryRecallEvents.semanticScore,
			keywordScore: memoryRecallEvents.keywordScore,
			temporalScore: memoryRecallEvents.temporalScore,
			pinnedBoost: memoryRecallEvents.pinnedBoost,
			finalScore: memoryRecallEvents.finalScore,
			weights: memoryRecallEvents.weights,
			createdAt: memoryRecallEvents.createdAt,
		})
		.from(memoryRecallEvents)
		.where(and(eq(memoryRecallEvents.userId, userId), eq(memoryRecallEvents.drawerId, drawerId)))
		.orderBy(desc(memoryRecallEvents.createdAt))
		.limit(limit)

	const [countRow] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(memoryRecallEvents)
		.where(and(eq(memoryRecallEvents.userId, userId), eq(memoryRecallEvents.drawerId, drawerId)))

	return { events, total: countRow?.n ?? 0 }
}
