import { command, query } from '$app/server'
import { z } from 'zod'
import {
	bumpAccessCount,
	createMemory,
	deleteMemoryRecord,
	getMemoryById,
	getMemoryRelations,
	getRelatedMemories,
	listMemories,
	pinMemoryRecord,
	searchMemories,
	unpinMemoryRecord,
	updateMemoryRecord,
} from '$lib/memory/memory.server'
import { buildImportPrompt, extractFromImportText } from '$lib/memory/memory'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { getTaxonomy, findTunnels } from '$lib/memory/palace.store'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/chat/chat.schema'
import { memoryRooms } from '$lib/memory/palace.schema'
import { and, desc, eq } from 'drizzle-orm'

const createMemorySchema = z.object({
	content: z.string().trim().min(1),
	category: z.string().trim().min(1).optional(),
	importance: z.number().min(0).max(1).optional(),
})

const listMemoriesSchema = z.object({
	search: z.string().trim().min(1).optional(),
	category: z.string().trim().min(1).optional(),
	limit: z.number().int().min(1).max(200).optional(),
})

const searchMemoriesSchema = z.object({
	text: z.string().trim().min(1),
	limit: z.number().int().min(1).max(20).optional(),
})

const updateMemorySchema = z.object({
	id: z.string().uuid(),
	content: z.string().trim().min(1).optional(),
	importance: z.number().min(0).max(1).optional(),
	category: z.string().trim().min(1).optional(),
})

const memoryIdSchema = z.object({
	id: z.string().uuid(),
})

const relatedMemoriesSchema = z.object({
	id: z.string().uuid(),
	depth: z.number().int().min(1).max(4).optional(),
})

export const createMemoryCommand = command(createMemorySchema, async ({ content, category, importance }) => {
	return createMemory(content, category ?? 'general', importance ?? 0.5)
})

export const listMemoriesQuery = query(listMemoriesSchema, async ({ search, category, limit }) => {
	return listMemories({ search, category, limit })
})

export const getMemoryByIdQuery = query(memoryIdSchema, async ({ id }) => {
	return getMemoryById(id)
})

export const searchMemoriesQuery = query(searchMemoriesSchema, async ({ text, limit }) => {
	return searchMemories(text, limit ?? 8)
})

export const getRelatedMemoriesQuery = query(relatedMemoriesSchema, async ({ id, depth }) => {
	return getRelatedMemories(id, depth ?? 1)
})

export const getMemoryRelationsQuery = query(memoryIdSchema, async ({ id }) => {
	return getMemoryRelations(id)
})

export const updateMemoryCommand = command(updateMemorySchema, async ({ id, content, importance, category }) => {
	return updateMemoryRecord(id, { content, importance, category })
})

export const deleteMemoryCommand = command(memoryIdSchema, async ({ id }) => {
	await deleteMemoryRecord(id)
	return { ok: true }
})

export const pinMemoryCommand = command(memoryIdSchema, async ({ id }) => {
	return pinMemoryRecord(id)
})

export const unpinMemoryCommand = command(memoryIdSchema, async ({ id }) => {
	return unpinMemoryRecord(id)
})

export const touchMemoryCommand = command(memoryIdSchema, async ({ id }) => {
	await bumpAccessCount(id)
	return { ok: true }
})

export const getPalaceTaxonomyQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return getTaxonomy(user.id)
})

const roomIdSchema = z.object({ roomId: z.string().uuid() })

export const getRoomTunnelsQuery = query(roomIdSchema, async ({ roomId }) => {
	const user = requireAuthenticatedRequestUser()
	const [room] = await db.select().from(memoryRooms).where(eq(memoryRooms.id, roomId)).limit(1)
	if (!room) return []
	return findTunnels(user.id, room.name)
})

export const listDreamingSessionsQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	const [dreaming] = await db.select().from(agents).where(eq(agents.name, 'Dreaming Agent')).limit(1)
	if (!dreaming) return []

	return db
		.select({
			id: conversations.id,
			title: conversations.title,
			updatedAt: conversations.updatedAt,
			createdAt: conversations.createdAt,
			model: conversations.model,
		})
		.from(conversations)
		.where(and(eq(conversations.userId, user.id), eq(conversations.agentId, dreaming.id)))
		.orderBy(desc(conversations.updatedAt))
		.limit(20)
})

/* ── Memory Importer ────────────────────────────────────────── */

const buildImportPromptSchema = z.object({
	includeExisting: z.boolean().optional(),
})

const importMemoriesSchema = z.object({
	text: z.string().trim().min(1),
	model: z.string().trim().min(1).optional(),
})

export const buildImportPromptQuery = query(buildImportPromptSchema, async ({ includeExisting }) => {
	return buildImportPrompt({ includeExisting })
})

export const importMemoriesCommand = command(importMemoriesSchema, async ({ text, model }) => {
	return extractFromImportText(text, model)
})
