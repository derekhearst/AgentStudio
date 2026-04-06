import { OpenRouter } from '@openrouter/sdk'
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { env } from '$env/dynamic/private'
import { db } from '$lib/db.server'
import { memories, memoryRelations } from '$lib/memory/memory.schema'

const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
const EMBEDDING_DIMENSIONS = 1536
const RELATION_TYPES = ['supports', 'contradicts', 'depends_on', 'part_of'] as const

export type MemoryRelationType = (typeof RELATION_TYPES)[number]

function isPinnedCategory(category: string) {
	return category === 'pinned' || category.startsWith('pinned:')
}

function ensurePinnedCategory(category: string) {
	if (isPinnedCategory(category)) return category
	if (!category || category === 'general') return 'pinned'
	return `pinned:${category}`
}

function unpinCategory(category: string) {
	if (category === 'pinned') return 'general'
	if (category.startsWith('pinned:')) return category.slice('pinned:'.length) || 'general'
	return category
}

let openRouterClient: OpenRouter | null = null

function getClient() {
	if (!env.OPENROUTER_API_KEY) {
		throw new Error('OPENROUTER_API_KEY is not configured')
	}
	if (!openRouterClient) {
		openRouterClient = new OpenRouter({ apiKey: env.OPENROUTER_API_KEY })
	}
	return openRouterClient
}

function toPgVector(values: number[]) {
	return `[${values.join(',')}]`
}

function normalizeEmbedding(embedding: number[]) {
	if (embedding.length >= EMBEDDING_DIMENSIONS) {
		return embedding.slice(0, EMBEDDING_DIMENSIONS)
	}
	return [...embedding, ...new Array(EMBEDDING_DIMENSIONS - embedding.length).fill(0)]
}

async function getEmbedding(content: string) {
	const client = getClient()
	const response = await client.embeddings.generate({
		requestBody: {
			model: EMBEDDING_MODEL,
			input: content,
			encodingFormat: 'float',
			dimensions: EMBEDDING_DIMENSIONS,
		},
	})

	if (typeof response === 'string') {
		throw new Error(response)
	}

	const vector = response.data?.[0]?.embedding
	if (!Array.isArray(vector)) {
		throw new Error('Embedding response did not include a numeric vector')
	}

	return normalizeEmbedding(vector)
}

export async function createMemory(content: string, category = 'general', importance = 0.5) {
	const embedding = await getEmbedding(content)
	const [created] = await db
		.insert(memories)
		.values({
			content,
			category,
			importance,
			embedding,
			updatedAt: new Date(),
		})
		.returning()

	return created
}

export async function searchMemories(query: string, limit = 8) {
	let semanticResults: Array<typeof memories.$inferSelect & { distance: number }> = []
	try {
		const embedding = await getEmbedding(query)
		const vectorLiteral = toPgVector(embedding)
		semanticResults = await db
			.select({
				id: memories.id,
				content: memories.content,
				category: memories.category,
				importance: memories.importance,
				embedding: memories.embedding,
				accessCount: memories.accessCount,
				lastAccessed: memories.lastAccessed,
				createdAt: memories.createdAt,
				updatedAt: memories.updatedAt,
				decayedAt: memories.decayedAt,
				distance: sql<number>`${memories.embedding} <=> ${vectorLiteral}`,
			})
			.from(memories)
			.where(sql`${memories.embedding} is not null`)
			.orderBy(sql`${memories.embedding} <=> ${vectorLiteral}`)
			.limit(limit)
	} catch {
		semanticResults = []
	}

	const textResults = await db
		.select()
		.from(memories)
		.where(or(ilike(memories.content, `%${query}%`), ilike(memories.category, `%${query}%`)))
		.orderBy(desc(memories.importance), desc(memories.updatedAt))
		.limit(limit)

	const merged = new Map<string, typeof memories.$inferSelect & { score: number }>()

	for (const row of textResults) {
		merged.set(row.id, {
			...row,
			score: Number(row.importance) + 0.25,
		})
	}

	for (const row of semanticResults) {
		const semanticScore = 1 / (1 + row.distance)
		const existing = merged.get(row.id)
		const candidateScore = semanticScore + Number(row.importance)
		if (!existing || candidateScore > existing.score) {
			merged.set(row.id, {
				id: row.id,
				content: row.content,
				category: row.category,
				importance: row.importance,
				embedding: row.embedding,
				accessCount: row.accessCount,
				lastAccessed: row.lastAccessed,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
				decayedAt: row.decayedAt,
				score: candidateScore,
			})
		}
	}

	return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

export async function getRelatedMemories(memoryId: string, depth = 1) {
	const maxDepth = Math.max(1, Math.min(depth, 4))
	let frontier = new Set([memoryId])
	const visited = new Set([memoryId])

	for (let layer = 0; layer < maxDepth; layer++) {
		const ids = [...frontier]
		if (ids.length === 0) break

		const relationRows = await db
			.select()
			.from(memoryRelations)
			.where(or(inArray(memoryRelations.sourceMemoryId, ids), inArray(memoryRelations.targetMemoryId, ids)))
			.limit(200)

		const next = new Set<string>()
		for (const row of relationRows) {
			if (!visited.has(row.sourceMemoryId)) {
				visited.add(row.sourceMemoryId)
				next.add(row.sourceMemoryId)
			}
			if (!visited.has(row.targetMemoryId)) {
				visited.add(row.targetMemoryId)
				next.add(row.targetMemoryId)
			}
		}

		frontier = next
	}

	visited.delete(memoryId)
	const relatedIds = [...visited]
	if (relatedIds.length === 0) return []

	return db.select().from(memories).where(inArray(memories.id, relatedIds))
}

export async function createMemoryRelation(
	sourceMemoryId: string,
	targetMemoryId: string,
	relationType: MemoryRelationType,
	strength = 0.5,
) {
	if (sourceMemoryId === targetMemoryId) return null
	if (!RELATION_TYPES.includes(relationType)) {
		throw new Error(`Unsupported relation type: ${relationType}`)
	}

	const [existing] = await db
		.select()
		.from(memoryRelations)
		.where(
			and(
				eq(memoryRelations.sourceMemoryId, sourceMemoryId),
				eq(memoryRelations.targetMemoryId, targetMemoryId),
				eq(memoryRelations.relationType, relationType),
			),
		)
		.limit(1)

	if (existing) {
		const [updated] = await db
			.update(memoryRelations)
			.set({
				strength: Math.max(existing.strength, Math.min(1, Math.max(0.05, strength))),
			})
			.where(eq(memoryRelations.id, existing.id))
			.returning()
		return updated
	}

	const [created] = await db
		.insert(memoryRelations)
		.values({
			sourceMemoryId,
			targetMemoryId,
			relationType,
			strength: Math.min(1, Math.max(0.05, strength)),
		})
		.returning()

	return created
}

export async function bumpAccessCount(memoryId: string) {
	await db
		.update(memories)
		.set({
			accessCount: sql`${memories.accessCount} + 1`,
			lastAccessed: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(memories.id, memoryId))
}

export async function decayMemories(lambda = 0.03) {
	const now = Date.now()
	const rows = await db.select().from(memories)

	for (const row of rows) {
		if (isPinnedCategory(row.category)) {
			continue
		}
		const lastTouched = row.lastAccessed ?? row.updatedAt ?? row.createdAt
		if (!lastTouched) continue
		const days = Math.max(0, (now - new Date(lastTouched).getTime()) / 86400000)
		const decayed = Number(row.importance) * Math.exp(-lambda * days)
		await db
			.update(memories)
			.set({
				importance: decayed,
				decayedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(memories.id, row.id))
	}
}

export async function pruneMemories(threshold = 0.08) {
	const doomed = await db
		.select({ id: memories.id })
		.from(memories)
		.where(and(sql`${memories.importance} < ${threshold}`, sql`${memories.category} not like 'pinned%'`))
	if (doomed.length === 0) return 0

	const ids = doomed.map((row) => row.id)
	await db.delete(memoryRelations).where(
		or(
			sql`${memoryRelations.sourceMemoryId} in ${sql.join(
				ids.map((id) => sql`${id}`),
				sql`, `,
			)}`,
			sql`${memoryRelations.targetMemoryId} in ${sql.join(
				ids.map((id) => sql`${id}`),
				sql`, `,
			)}`,
		),
	)
	await db.delete(memories).where(
		sql`${memories.id} in ${sql.join(
			ids.map((id) => sql`${id}`),
			sql`, `,
		)}`,
	)
	return ids.length
}

export async function updateMemoryRecord(
	memoryId: string,
	fields: { content?: string; importance?: number; category?: string },
) {
	const patch: Partial<typeof memories.$inferInsert> = {
		updatedAt: new Date(),
	}

	if (typeof fields.content === 'string' && fields.content.trim()) {
		patch.content = fields.content.trim()
		patch.embedding = await getEmbedding(fields.content.trim())
	}
	if (typeof fields.importance === 'number') {
		patch.importance = fields.importance
	}
	if (typeof fields.category === 'string' && fields.category.trim()) {
		patch.category = fields.category.trim()
	}

	const [updated] = await db.update(memories).set(patch).where(eq(memories.id, memoryId)).returning()
	return updated
}

export async function deleteMemoryRecord(memoryId: string) {
	await db
		.delete(memoryRelations)
		.where(or(eq(memoryRelations.sourceMemoryId, memoryId), eq(memoryRelations.targetMemoryId, memoryId)))
	await db.delete(memories).where(eq(memories.id, memoryId))
}

export async function pinMemoryRecord(memoryId: string) {
	const [current] = await db.select().from(memories).where(eq(memories.id, memoryId)).limit(1)
	if (!current) {
		throw new Error('Memory not found')
	}

	const [updated] = await db
		.update(memories)
		.set({
			importance: 1,
			category: ensurePinnedCategory(current.category),
			lastAccessed: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(memories.id, memoryId))
		.returning()
	return updated
}

export async function unpinMemoryRecord(memoryId: string) {
	const [current] = await db.select().from(memories).where(eq(memories.id, memoryId)).limit(1)
	if (!current) {
		throw new Error('Memory not found')
	}

	const [updated] = await db
		.update(memories)
		.set({
			category: unpinCategory(current.category),
			updatedAt: new Date(),
		})
		.where(eq(memories.id, memoryId))
		.returning()
	return updated
}

export async function getMemoryById(memoryId: string) {
	const [memory] = await db.select().from(memories).where(eq(memories.id, memoryId)).limit(1)
	return memory ?? null
}

export async function getMemoryRelations(memoryId: string) {
	const relations = await db
		.select()
		.from(memoryRelations)
		.where(or(eq(memoryRelations.sourceMemoryId, memoryId), eq(memoryRelations.targetMemoryId, memoryId)))

	if (relations.length === 0) {
		return []
	}

	const neighborIds = new Set<string>()
	for (const relation of relations) {
		neighborIds.add(relation.sourceMemoryId)
		neighborIds.add(relation.targetMemoryId)
	}
	neighborIds.delete(memoryId)

	const neighbors = [...neighborIds].length
		? await db
				.select()
				.from(memories)
				.where(inArray(memories.id, [...neighborIds]))
		: []

	const byId = new Map(neighbors.map((neighbor) => [neighbor.id, neighbor]))

	return relations.map((relation) => {
		const direction: 'outgoing' | 'incoming' = relation.sourceMemoryId === memoryId ? 'outgoing' : 'incoming'
		const otherId = direction === 'outgoing' ? relation.targetMemoryId : relation.sourceMemoryId
		return {
			...relation,
			direction,
			otherMemory: byId.get(otherId) ?? null,
		}
	})
}

export async function listMemories(options?: { search?: string; category?: string; limit?: number }) {
	const limit = options?.limit ?? 50
	const where = and(
		options?.search ? ilike(memories.content, `%${options.search}%`) : undefined,
		options?.category ? eq(memories.category, options.category) : undefined,
	)

	return db
		.select()
		.from(memories)
		.where(where)
		.orderBy(desc(memories.importance), desc(memories.updatedAt))
		.limit(limit)
}
