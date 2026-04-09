import { and, asc, desc, eq, ilike, inArray, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { createMemory, getRelatedMemories } from '$lib/memory/memory.server'
import { memories } from '$lib/memory/memory.schema'
import { hallTypeEnum, memoryRooms, memoryWings } from '$lib/memory/palace.schema'

export type HallType = (typeof hallTypeEnum.enumValues)[number]

type PlaceMemoryInput = {
	content: string
	category?: string
	importance?: number
	wingId?: string | null
	roomId?: string | null
	hallType?: HallType
	isCloset?: boolean
	closetForRoomId?: string | null
}

function normalizeRoomName(name: string) {
	return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

export async function createWing(userId: string, name: string, description?: string) {
	const [created] = await db
		.insert(memoryWings)
		.values({
			userId,
			name: name.trim(),
			description: description?.trim() || null,
			updatedAt: new Date(),
		})
		.returning()

	return created
}

export async function listWings(userId: string) {
	return db
		.select()
		.from(memoryWings)
		.where(eq(memoryWings.userId, userId))
		.orderBy(asc(memoryWings.name), desc(memoryWings.updatedAt))
}

export async function createRoom(
	wingId: string,
	name: string,
	options?: { description?: string; closetForRoomId?: string },
) {
	const [created] = await db
		.insert(memoryRooms)
		.values({
			wingId,
			name: name.trim(),
			description: options?.description?.trim() || null,
			isCloset: Boolean(options?.closetForRoomId),
			closetForRoomId: options?.closetForRoomId ?? null,
			updatedAt: new Date(),
		})
		.returning()

	return created
}

export async function listRooms(wingId: string) {
	return db
		.select()
		.from(memoryRooms)
		.where(eq(memoryRooms.wingId, wingId))
		.orderBy(asc(memoryRooms.name), desc(memoryRooms.updatedAt))
}

export async function getTaxonomy(userId: string) {
	const wings = await listWings(userId)
	if (wings.length === 0) return []

	const wingIds = wings.map((wing) => wing.id)
	const rooms = await db
		.select()
		.from(memoryRooms)
		.where(inArray(memoryRooms.wingId, wingIds))
		.orderBy(asc(memoryRooms.name))

	const byWing = new Map<string, (typeof memoryRooms.$inferSelect)[]>()
	for (const room of rooms) {
		const current = byWing.get(room.wingId) ?? []
		current.push(room)
		byWing.set(room.wingId, current)
	}

	return wings.map((wing) => ({
		...wing,
		rooms: byWing.get(wing.id) ?? [],
	}))
}

export async function findTunnels(userId: string, roomName: string) {
	const normalized = normalizeRoomName(roomName)
	if (!normalized) return []

	return db
		.select({
			roomId: memoryRooms.id,
			roomName: memoryRooms.name,
			wingId: memoryWings.id,
			wingName: memoryWings.name,
		})
		.from(memoryRooms)
		.innerJoin(memoryWings, eq(memoryWings.id, memoryRooms.wingId))
		.where(and(eq(memoryWings.userId, userId), sql`lower(trim(${memoryRooms.name})) = ${normalized}`))
		.orderBy(asc(memoryWings.name))
}

export async function placeMemory(input: PlaceMemoryInput) {
	const created = await createMemory(input.content, input.category ?? 'general', input.importance ?? 0.5)

	const [updated] = await db
		.update(memories)
		.set({
			wingId: input.wingId ?? null,
			roomId: input.roomId ?? null,
			hallType: input.hallType ?? 'discoveries',
			isCloset: input.isCloset ?? false,
			closetForRoomId: input.closetForRoomId ?? null,
			updatedAt: new Date(),
		})
		.where(eq(memories.id, created.id))
		.returning()

	return updated
}

export async function getClosetForRoom(roomId: string) {
	const [room] = await db.select().from(memoryRooms).where(eq(memoryRooms.id, roomId)).limit(1)
	if (!room) return null

	const [closet] = await db
		.select()
		.from(memoryRooms)
		.where(and(eq(memoryRooms.closetForRoomId, roomId), eq(memoryRooms.isCloset, true)))
		.limit(1)

	if (closet) return closet

	const [closetByName] = await db
		.select()
		.from(memoryRooms)
		.where(and(eq(memoryRooms.wingId, room.wingId), ilike(memoryRooms.name, `${room.name} closet`)))
		.limit(1)

	return closetByName ?? null
}

export async function traverseFromRoom(roomId: string, depth = 1) {
	const [origin] = await db.select().from(memoryRooms).where(eq(memoryRooms.id, roomId)).limit(1)
	if (!origin) return null

	const roomMemories = await db
		.select()
		.from(memories)
		.where(eq(memories.roomId, roomId))
		.orderBy(desc(memories.importance), desc(memories.updatedAt))
		.limit(80)

	const related =
		depth > 1
			? (
					await Promise.all(
						roomMemories.slice(0, 10).map((memory) => getRelatedMemories(memory.id, Math.min(4, depth - 1))),
					)
				).flat()
			: []

	const relatedUnique = new Map<string, typeof memories.$inferSelect>()
	for (const item of related) {
		relatedUnique.set(item.id, item)
	}

	return {
		room: origin,
		memories: roomMemories,
		relatedMemories: [...relatedUnique.values()].filter((memory) => memory.roomId !== roomId),
	}
}
