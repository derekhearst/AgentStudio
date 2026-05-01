/**
 * SvelteKit remote queries/commands for the memory palace UI.
 */

import { command, query } from '$app/server'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import {
	memoryClosets,
	memoryDrawers,
	memoryRooms,
	memoryWings,
} from '$lib/memory/memory.schema'
import { recallForUser } from '$lib/memory/memory.server'

const searchSchema = z.object({
	query: z.string().trim().min(1).max(2000),
	topK: z.number().int().min(1).max(20).optional(),
	useRerank: z.boolean().optional(),
})

const drawerIdSchema = z.object({ id: z.string().uuid() })

export const listMemoryWingsQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return db
		.select()
		.from(memoryWings)
		.where(eq(memoryWings.userId, user.id))
		.orderBy(memoryWings.name)
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
		.select()
		.from(memoryRooms)
		.where(eq(memoryRooms.wingId, wingId))
		.orderBy(desc(memoryRooms.occurredAt))
})

const roomIdSchema = z.object({ roomId: z.string().uuid() })

export const listMemoryClosetsQuery = query(roomIdSchema, async ({ roomId }) => {
	requireAuthenticatedRequestUser()
	return db.select().from(memoryClosets).where(eq(memoryClosets.roomId, roomId))
})

const closetIdSchema = z.object({ closetId: z.string().uuid() })

export const listMemoryDrawersQuery = query(closetIdSchema, async ({ closetId }) => {
	const user = requireAuthenticatedRequestUser()
	return db
		.select({
			id: memoryDrawers.id,
			role: memoryDrawers.role,
			content: memoryDrawers.content,
			aaak: memoryDrawers.aaak,
			tokenCount: memoryDrawers.tokenCount,
			occurredAt: memoryDrawers.occurredAt,
		})
		.from(memoryDrawers)
		.where(and(eq(memoryDrawers.closetId, closetId), eq(memoryDrawers.userId, user.id)))
		.orderBy(memoryDrawers.occurredAt)
})

export const searchMemoryQuery = query(searchSchema, async ({ query: q, topK, useRerank }) => {
	const user = requireAuthenticatedRequestUser()
	return recallForUser(user.id, q, { topK: topK ?? 5, useRerank: useRerank ?? false })
})

export const deleteMemoryDrawerCommand = command(drawerIdSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	await db
		.delete(memoryDrawers)
		.where(and(eq(memoryDrawers.id, id), eq(memoryDrawers.userId, user.id)))
	return { ok: true }
})
