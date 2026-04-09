import { and, desc, eq, gte, ilike, inArray, isNull, notInArray, or } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { memories } from '$lib/memory/memory.schema'
import { searchMemories } from '$lib/memory/memory.server'
import { memoryWings } from '$lib/memory/palace.schema'

type LayerMemory = {
	id: string
	content: string
	category: string
	importance: number
	hallType: string
}

type WakeUpResult = {
	systemPrompt: string
	recalledMemoryIds: string[]
	layers: {
		l0: LayerMemory[]
		l1: LayerMemory[]
		l2: LayerMemory[]
		l3: LayerMemory[]
	}
}

function toLayerMemory(memory: typeof memories.$inferSelect): LayerMemory {
	return {
		id: memory.id,
		content: memory.content,
		category: memory.category,
		importance: Number(memory.importance),
		hallType: memory.hallType,
	}
}

function renderLayer(label: string, items: LayerMemory[]) {
	if (items.length === 0) return `${label}: (none yet)`
	return [
		`${label}:`,
		...items.map((memory, index) => `${index + 1}. [${memory.hallType}/${memory.category}] ${memory.content}`),
	].join('\n')
}

export class MemoryStack {
	constructor(private readonly userId: string) {}

	private async memoryScopePredicate() {
		const userWingRows = await db
			.select({ id: memoryWings.id })
			.from(memoryWings)
			.where(eq(memoryWings.userId, this.userId))

		const userWingIds = userWingRows.map((row) => row.id)
		if (userWingIds.length === 0) {
			return isNull(memories.wingId)
		}

		return or(isNull(memories.wingId), inArray(memories.wingId, userWingIds))
	}

	private async loadL0() {
		const scope = await this.memoryScopePredicate()
		const rows = await db
			.select()
			.from(memories)
			.where(
				and(
					scope,
					gte(memories.importance, 0.6),
					or(
						eq(memories.hallType, 'preferences'),
						eq(memories.hallType, 'facts'),
						ilike(memories.category, 'identity%'),
					),
				),
			)
			.orderBy(desc(memories.importance), desc(memories.updatedAt))
			.limit(6)

		return rows.map(toLayerMemory)
	}

	private async loadL1(excludeIds: string[]) {
		const scope = await this.memoryScopePredicate()
		const closetWhere = excludeIds.length
			? and(scope, eq(memories.isCloset, true), notInArray(memories.id, excludeIds))
			: and(scope, eq(memories.isCloset, true))

		const closets = await db
			.select()
			.from(memories)
			.where(closetWhere)
			.orderBy(desc(memories.importance), desc(memories.accessCount), desc(memories.updatedAt))
			.limit(6)

		const fallbackExclude = [...excludeIds, ...closets.map((memory) => memory.id)]
		const drawerWhere = fallbackExclude.length
			? and(scope, eq(memories.isCloset, false), notInArray(memories.id, fallbackExclude))
			: and(scope, eq(memories.isCloset, false))

		const drawers = await db
			.select()
			.from(memories)
			.where(drawerWhere)
			.orderBy(desc(memories.importance), desc(memories.accessCount), desc(memories.updatedAt))
			.limit(10)

		const rows = [...closets, ...drawers].slice(0, 10)

		return rows.map(toLayerMemory)
	}

	private async loadL2(topic: string | undefined, excludeIds: string[]) {
		if (!topic?.trim()) return []
		const scope = await this.memoryScopePredicate()
		const candidates = await searchMemories(topic.trim(), 8)
		const filtered = candidates.filter((memory) => !excludeIds.includes(memory.id)).slice(0, 6)
		if (filtered.length === 0) return []

		const ids = filtered.map((memory) => memory.id)
		const rows = await db
			.select()
			.from(memories)
			.where(and(scope, inArray(memories.id, ids)))

		const byId = new Map(rows.map((row) => [row.id, row]))
		return ids
			.map((id) => byId.get(id))
			.filter((row): row is typeof memories.$inferSelect => Boolean(row))
			.map(toLayerMemory)
	}

	private async loadL3(topic: string | undefined, excludeIds: string[]) {
		if (!topic?.trim()) return []
		const candidates = await searchMemories(topic.trim(), 20)
		const filtered = candidates
			.filter((memory) => !excludeIds.includes(memory.id))
			.filter((memory) => Number(memory.importance) >= 0.2)
			.slice(0, 8)

		return filtered.map((memory) => ({
			id: memory.id,
			content: memory.content,
			category: memory.category,
			importance: Number(memory.importance),
			hallType: memory.hallType,
		}))
	}

	async wakeUp(topic?: string): Promise<WakeUpResult> {
		const l0 = await this.loadL0()
		const l0Ids = l0.map((memory) => memory.id)
		const l1 = await this.loadL1(l0Ids)
		const l2 = await this.loadL2(topic, [...l0Ids, ...l1.map((memory) => memory.id)])
		const l3 =
			topic?.trim() && l2.length < 3
				? await this.loadL3(topic, [...l0Ids, ...l1.map((memory) => memory.id), ...l2.map((memory) => memory.id)])
				: []

		const recalledMemoryIds = [...new Set([...l0, ...l1, ...l2, ...l3].map((memory) => memory.id))]

		return {
			recalledMemoryIds,
			layers: { l0, l1, l2, l3 },
			systemPrompt: [
				'Memory Palace context for this reply:',
				renderLayer('L0 Identity (always loaded)', l0),
				renderLayer('L1 Essential story (always loaded)', l1),
				renderLayer('L2 Topic recall (on demand)', l2),
				renderLayer('L3 Deep search (semantic fallback)', l3),
				'Use these as soft constraints and prefer newer facts when conflicts exist.',
			].join('\n\n'),
		}
	}
}
