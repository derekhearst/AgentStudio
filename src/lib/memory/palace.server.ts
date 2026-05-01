/**
 * Wing / Room / Closet helpers — getOrCreate semantics with slug + alias dedupe.
 *
 * Ported from MemPalace's `palace.py`.
 */

import { and, eq, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import {
	memoryClosets,
	memoryRooms,
	memoryWings,
	type MemoryCloset,
	type MemoryRoom,
	type MemoryWing,
} from '$lib/memory/memory.schema'

export type WingKind = 'person' | 'project' | 'topic' | 'agent'

export function slugify(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[\s_/]+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '') || 'untitled'
}

export async function getOrCreateWing(opts: {
	userId: string
	kind: WingKind
	name: string
	aliases?: string[]
	agentId?: string | null
}): Promise<MemoryWing> {
	const slug = slugify(opts.name)
	const aliases = (opts.aliases ?? []).map((alias) => alias.toLowerCase().trim()).filter(Boolean)

	// 1) exact slug match
	const [existing] = await db
		.select()
		.from(memoryWings)
		.where(and(eq(memoryWings.userId, opts.userId), eq(memoryWings.slug, slug)))
		.limit(1)
	if (existing) return existing

	// 2) alias match (any of supplied aliases overlaps the row's aliases array)
	if (aliases.length > 0) {
		const [aliasMatch] = await db
			.select()
			.from(memoryWings)
			.where(
				and(
					eq(memoryWings.userId, opts.userId),
					sql`${memoryWings.aliases} && ARRAY[${sql.join(aliases.map((a) => sql`${a}`), sql`, `)}]::text[]`,
				),
			)
			.limit(1)
		if (aliasMatch) return aliasMatch
	}

	const [created] = await db
		.insert(memoryWings)
		.values({
			userId: opts.userId,
			agentId: opts.agentId ?? null,
			kind: opts.kind,
			name: opts.name,
			slug,
			aliases,
		})
		.returning()
	return created
}

export async function getOrCreateRoom(opts: {
	wingId: string
	label: string
	occurredAt: Date
	conversationId?: string | null
	summary?: string | null
}): Promise<MemoryRoom> {
	// One room per (wing, day, conversation). The label is a human-readable
	// timestamp; dedupe is keyed on the same triple.
	const dayStart = new Date(opts.occurredAt)
	dayStart.setUTCHours(0, 0, 0, 0)
	const dayEnd = new Date(dayStart)
	dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)

	const conversationFilter = opts.conversationId
		? eq(memoryRooms.conversationId, opts.conversationId)
		: sql`${memoryRooms.conversationId} IS NULL`

	const [existing] = await db
		.select()
		.from(memoryRooms)
		.where(
			and(
				eq(memoryRooms.wingId, opts.wingId),
				conversationFilter,
				eq(memoryRooms.label, opts.label),
				sql`${memoryRooms.occurredAt} >= ${dayStart.toISOString()}`,
				sql`${memoryRooms.occurredAt} < ${dayEnd.toISOString()}`,
			),
		)
		.limit(1)
	if (existing) return existing

	const [created] = await db
		.insert(memoryRooms)
		.values({
			wingId: opts.wingId,
			conversationId: opts.conversationId ?? null,
			label: opts.label,
			summary: opts.summary ?? null,
			occurredAt: opts.occurredAt,
		})
		.returning()
	return created
}

export async function getOrCreateCloset(opts: {
	roomId: string
	topic: string
	summary?: string | null
}): Promise<MemoryCloset> {
	const topic = opts.topic.trim() || 'general'
	const [existing] = await db
		.select()
		.from(memoryClosets)
		.where(and(eq(memoryClosets.roomId, opts.roomId), eq(memoryClosets.topic, topic)))
		.limit(1)
	if (existing) return existing

	const [created] = await db
		.insert(memoryClosets)
		.values({
			roomId: opts.roomId,
			topic,
			summary: opts.summary ?? null,
		})
		.returning()
	return created
}

export async function listWingsForUser(userId: string): Promise<MemoryWing[]> {
	return db.select().from(memoryWings).where(eq(memoryWings.userId, userId))
}
