import { command, query } from '$app/server'
import { and, desc, eq, ilike, max, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { artifacts, artifactVersions, artifactTypeEnum } from '$lib/artifacts/artifacts.schema'

// ── Schemas ──────────────────────────────────────────────────

const artifactTypeValues = artifactTypeEnum.enumValues
type ArtifactType = (typeof artifactTypeValues)[number]

const createArtifactSchema = z.object({
	type: z.enum(artifactTypeValues as [ArtifactType, ...ArtifactType[]]),
	title: z.string().trim().min(1).max(200),
	content: z.string().default(''),
	language: z.string().trim().max(60).nullish(),
	mimeType: z.string().trim().max(120).nullish(),
	url: z.string().trim().max(2000).nullish(),
	category: z.string().trim().max(60).nullish(),
	tags: z.array(z.string().trim().max(60)).max(20).default([]),
	conversationId: z.string().uuid().nullish(),
	messageId: z.string().uuid().nullish(),
})

const updateArtifactSchema = z.object({
	id: z.string().uuid(),
	title: z.string().trim().min(1).max(200).optional(),
	content: z.string().optional(),
	language: z.string().trim().max(60).nullish(),
	type: z.enum(artifactTypeValues as [ArtifactType, ...ArtifactType[]]).optional(),
})

const artifactIdSchema = z.string().uuid()

const listArtifactsSchema = z.object({
	type: z.enum(artifactTypeValues as [ArtifactType, ...ArtifactType[]]).nullish(),
	category: z.string().trim().max(60).nullish(),
	search: z.string().trim().max(200).nullish(),
	conversationId: z.string().uuid().nullish(),
	pinned: z.boolean().nullish(),
	limit: z.number().int().min(1).max(100).default(50),
	offset: z.number().int().min(0).default(0),
})

const updateStorageSchema = z.object({
	id: z.string().uuid(),
	key: z.string().trim().min(1).max(200),
	value: z.unknown(),
})

const pinArtifactSchema = z.object({
	id: z.string().uuid(),
	pinned: z.boolean(),
})

const updateTagsSchema = z.object({
	id: z.string().uuid(),
	tags: z.array(z.string().trim().max(60)).max(20),
})

const updateCategorySchema = z.object({
	id: z.string().uuid(),
	category: z.string().trim().max(60).nullable(),
})

const versionIdSchema = z.object({
	id: z.string().uuid(),
	version: z.number().int().positive(),
})

const rollbackSchema = z.object({
	id: z.string().uuid(),
	version: z.number().int().positive(),
})

// ── Queries ──────────────────────────────────────────────────

export const getArtifact = query(artifactIdSchema, async (id) => {
	const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1)
	if (!artifact) return null

	// Bump access count
	await db
		.update(artifacts)
		.set({ accessCount: sql`${artifacts.accessCount} + 1`, lastAccessed: new Date() })
		.where(eq(artifacts.id, id))

	return artifact
})

export const getArtifactVersions = query(artifactIdSchema, async (id) => {
	return await db
		.select()
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, id))
		.orderBy(desc(artifactVersions.version))
})

export const getArtifactVersion = query(versionIdSchema, async ({ id, version }) => {
	const [row] = await db
		.select()
		.from(artifactVersions)
		.where(and(eq(artifactVersions.artifactId, id), eq(artifactVersions.version, version)))
		.limit(1)
	return row ?? null
})

export const listArtifacts = query(listArtifactsSchema, async (filters) => {
	const conditions = []

	if (filters.type) conditions.push(eq(artifacts.type, filters.type))
	if (filters.category) conditions.push(eq(artifacts.category, filters.category))
	if (filters.conversationId) conditions.push(eq(artifacts.conversationId, filters.conversationId))
	if (filters.pinned !== null && filters.pinned !== undefined) conditions.push(eq(artifacts.pinned, filters.pinned))
	if (filters.search) {
		conditions.push(or(ilike(artifacts.title, `%${filters.search}%`), ilike(artifacts.content, `%${filters.search}%`)))
	}

	const where = conditions.length > 0 ? and(...conditions) : undefined

	const rows = await db
		.select()
		.from(artifacts)
		.where(where)
		.orderBy(desc(artifacts.pinned), desc(artifacts.updatedAt))
		.limit(filters.limit)
		.offset(filters.offset)

	return rows
})

export const getArtifactsByConversation = query(z.string().uuid(), async (conversationId) => {
	return await db
		.select()
		.from(artifacts)
		.where(eq(artifacts.conversationId, conversationId))
		.orderBy(desc(artifacts.createdAt))
})

export const getRecentArtifacts = query(z.number().int().min(1).max(50).default(10), async (limit) => {
	return await db.select().from(artifacts).orderBy(desc(artifacts.updatedAt)).limit(limit)
})

export const getArtifactStorage = query(artifactIdSchema, async (id) => {
	const [row] = await db.select({ storage: artifacts.storage }).from(artifacts).where(eq(artifacts.id, id)).limit(1)
	return row?.storage ?? {}
})

// ── Commands ─────────────────────────────────────────────────

export const createArtifact = command(createArtifactSchema, async (input) => {
	const [artifact] = await db
		.insert(artifacts)
		.values({
			type: input.type,
			title: input.title,
			content: input.content,
			language: input.language ?? null,
			mimeType: input.mimeType ?? null,
			url: input.url ?? null,
			category: input.category ?? null,
			tags: input.tags,
			conversationId: input.conversationId ?? null,
			messageId: input.messageId ?? null,
		})
		.returning()

	// Create version 1
	await db.insert(artifactVersions).values({
		artifactId: artifact.id,
		version: 1,
		content: input.content,
		language: input.language ?? null,
		metadata: {},
	})

	return artifact
})

export const updateArtifact = command(updateArtifactSchema, async (input) => {
	const [existing] = await db.select().from(artifacts).where(eq(artifacts.id, input.id)).limit(1)
	if (!existing) throw new Error('Artifact not found')

	const updates: Record<string, unknown> = { updatedAt: new Date() }
	if (input.title !== undefined) updates.title = input.title
	if (input.content !== undefined) updates.content = input.content
	if (input.language !== undefined) updates.language = input.language
	if (input.type !== undefined) updates.type = input.type

	const [updated] = await db.update(artifacts).set(updates).where(eq(artifacts.id, input.id)).returning()

	// Auto-version if content changed
	if (input.content !== undefined && input.content !== existing.content) {
		// Get next version number
		const [maxRow] = await db
			.select({ maxVersion: max(artifactVersions.version) })
			.from(artifactVersions)
			.where(eq(artifactVersions.artifactId, input.id))

		const nextVersion = (maxRow?.maxVersion ?? 0) + 1

		await db.insert(artifactVersions).values({
			artifactId: input.id,
			version: nextVersion,
			content: input.content,
			language: input.language ?? existing.language,
			metadata: {},
		})
	}

	return updated
})

export const deleteArtifact = command(artifactIdSchema, async (id) => {
	await db.delete(artifacts).where(eq(artifacts.id, id))
	return { success: true }
})

export const updateArtifactStorage = command(updateStorageSchema, async (input) => {
	const [existing] = await db
		.select({ storage: artifacts.storage })
		.from(artifacts)
		.where(eq(artifacts.id, input.id))
		.limit(1)

	if (!existing) throw new Error('Artifact not found')

	const newStorage = { ...existing.storage, [input.key]: input.value }

	await db.update(artifacts).set({ storage: newStorage, updatedAt: new Date() }).where(eq(artifacts.id, input.id))

	return newStorage
})

export const pinArtifact = command(pinArtifactSchema, async (input) => {
	await db.update(artifacts).set({ pinned: input.pinned, updatedAt: new Date() }).where(eq(artifacts.id, input.id))
	return { success: true }
})

export const updateArtifactTags = command(updateTagsSchema, async (input) => {
	await db.update(artifacts).set({ tags: input.tags, updatedAt: new Date() }).where(eq(artifacts.id, input.id))
	return { success: true }
})

export const updateArtifactCategory = command(updateCategorySchema, async (input) => {
	await db.update(artifacts).set({ category: input.category, updatedAt: new Date() }).where(eq(artifacts.id, input.id))
	return { success: true }
})

export const rollbackArtifact = command(rollbackSchema, async (input) => {
	// Fetch the target version
	const [targetVersion] = await db
		.select()
		.from(artifactVersions)
		.where(and(eq(artifactVersions.artifactId, input.id), eq(artifactVersions.version, input.version)))
		.limit(1)

	if (!targetVersion) throw new Error('Version not found')

	// Get next version number
	const [maxRow] = await db
		.select({ maxVersion: max(artifactVersions.version) })
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, input.id))

	const nextVersion = (maxRow?.maxVersion ?? 0) + 1

	// Create new version with old content
	await db.insert(artifactVersions).values({
		artifactId: input.id,
		version: nextVersion,
		content: targetVersion.content,
		language: targetVersion.language,
		metadata: { rolledBackFrom: input.version },
	})

	// Update artifact to restored content
	await db
		.update(artifacts)
		.set({
			content: targetVersion.content,
			language: targetVersion.language,
			updatedAt: new Date(),
		})
		.where(eq(artifacts.id, input.id))

	return { success: true, restoredVersion: input.version, newVersion: nextVersion }
})
