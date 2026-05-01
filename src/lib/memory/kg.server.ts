/**
 * Temporal Knowledge Graph — entities + time-bounded relations.
 *
 * Ported from MemPalace's `knowledge_graph.py`. Each relation has a validity
 * window [validFrom, validTo). Invalidating a relation closes the window
 * rather than deleting the row, giving us a full timeline.
 */

import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import {
	memoryKgEntities,
	memoryKgRelations,
	type MemoryKgEntity,
	type MemoryKgRelation,
} from '$lib/memory/memory.schema'

export async function getOrCreateEntity(opts: {
	userId: string
	name: string
	type?: string
	attributes?: Record<string, unknown>
}): Promise<MemoryKgEntity> {
	const type = opts.type ?? 'thing'
	const [existing] = await db
		.select()
		.from(memoryKgEntities)
		.where(
			and(
				eq(memoryKgEntities.userId, opts.userId),
				eq(memoryKgEntities.name, opts.name),
				eq(memoryKgEntities.type, type),
			),
		)
		.limit(1)
	if (existing) return existing
	const [created] = await db
		.insert(memoryKgEntities)
		.values({
			userId: opts.userId,
			name: opts.name,
			type,
			attributes: opts.attributes ?? {},
		})
		.returning()
	return created
}

export async function addRelation(opts: {
	userId: string
	fromEntityId: string
	toEntityId: string
	relation: string
	validFrom?: Date
	confidence?: number
	sourceDrawerId?: string | null
}): Promise<MemoryKgRelation> {
	const [created] = await db
		.insert(memoryKgRelations)
		.values({
			userId: opts.userId,
			fromEntityId: opts.fromEntityId,
			toEntityId: opts.toEntityId,
			relation: opts.relation,
			validFrom: opts.validFrom ?? new Date(),
			confidence: opts.confidence ?? 1,
			sourceDrawerId: opts.sourceDrawerId ?? null,
		})
		.returning()
	return created
}

export async function invalidateRelation(opts: {
	relationId: string
	validTo?: Date
}): Promise<MemoryKgRelation | null> {
	const [updated] = await db
		.update(memoryKgRelations)
		.set({ validTo: opts.validTo ?? new Date() })
		.where(eq(memoryKgRelations.id, opts.relationId))
		.returning()
	return updated ?? null
}

export type KgQuery = {
	userId: string
	entityId?: string
	relation?: string
	at?: Date
}

export async function queryRelations(query: KgQuery): Promise<MemoryKgRelation[]> {
	const conditions = [eq(memoryKgRelations.userId, query.userId)]
	if (query.entityId) {
		conditions.push(
			or(eq(memoryKgRelations.fromEntityId, query.entityId), eq(memoryKgRelations.toEntityId, query.entityId))!,
		)
	}
	if (query.relation) {
		conditions.push(eq(memoryKgRelations.relation, query.relation))
	}
	if (query.at) {
		conditions.push(lte(memoryKgRelations.validFrom, query.at))
		conditions.push(or(isNull(memoryKgRelations.validTo), sql`${memoryKgRelations.validTo} > ${query.at}`)!)
	}
	return db
		.select()
		.from(memoryKgRelations)
		.where(and(...conditions))
		.orderBy(desc(memoryKgRelations.validFrom))
}

export async function timeline(opts: { userId: string; entityId: string }): Promise<MemoryKgRelation[]> {
	return db
		.select()
		.from(memoryKgRelations)
		.where(
			and(
				eq(memoryKgRelations.userId, opts.userId),
				or(eq(memoryKgRelations.fromEntityId, opts.entityId), eq(memoryKgRelations.toEntityId, opts.entityId))!,
			),
		)
		.orderBy(memoryKgRelations.validFrom)
}
