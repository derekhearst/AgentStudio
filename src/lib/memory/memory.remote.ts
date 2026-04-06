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
import { listDreamCycles, runDreamCycle } from '$lib/memory/memory'
import { buildImportPrompt, extractFromImportText } from '$lib/memory/memory'

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

const runDreamCycleSchema = z.object({
	decayLambda: z.number().positive().max(1).optional(),
	pruneThreshold: z.number().min(0).max(1).optional(),
	topCount: z.number().int().min(1).max(200).optional(),
	conversationLimit: z.number().int().min(1).max(50).optional(),
	lookbackHours: z
		.number()
		.int()
		.min(1)
		.max(24 * 30)
		.optional(),
})

const listDreamCyclesSchema = z.object({
	limit: z.number().int().min(1).max(100).optional(),
})

export const runDreamCycleCommand = command(
	runDreamCycleSchema,
	async ({ decayLambda, pruneThreshold, topCount, conversationLimit, lookbackHours }) => {
		return runDreamCycle({ decayLambda, pruneThreshold, topCount, conversationLimit, lookbackHours })
	},
)

export const listDreamCyclesQuery = query(listDreamCyclesSchema, async ({ limit }) => {
	return listDreamCycles(limit ?? 20)
})
