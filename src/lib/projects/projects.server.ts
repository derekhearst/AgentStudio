import { and, asc, desc, eq, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import {
	artifactVersions,
	artifacts,
	projects,
	type ArtifactContentType,
	type ArtifactRow,
	type ArtifactVersionRow,
	type ProjectKind,
	type ProjectRow,
} from './projects.schema'

/**
 * Wave 4 #15 phase 1 — projects + artifacts + version helpers.
 *
 * All operations are user-scoped — listProjects/createProject etc. take a `userId` and the
 * remote layer enforces it. Slug generation is automatic + collision-resilient (appends `-2`,
 * `-3` etc. on conflict). Artifact versions are append-only — even rollback creates a NEW
 * version row that copies the target seq's content forward.
 */

// ─────────── Slug helpers ───────────

const SLUG_SAFE_CHARS = /[^a-z0-9-]/g
const MULTI_DASH = /-+/g

export function slugify(input: string): string {
	const base = input
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, '-')
		.replace(SLUG_SAFE_CHARS, '')
		.replace(MULTI_DASH, '-')
		.replace(/^-+|-+$/g, '')
	return base.length > 0 ? base.slice(0, 64) : 'untitled'
}

async function uniqueProjectSlug(userId: string | null, baseSlug: string): Promise<string> {
	const existing = await db
		.select({ slug: projects.slug })
		.from(projects)
		.where(userId === null ? drizzleSql`${projects.userId} is null` : eq(projects.userId, userId))
	const taken = new Set(existing.map((r) => r.slug))
	if (!taken.has(baseSlug)) return baseSlug
	for (let i = 2; i < 1000; i++) {
		const candidate = `${baseSlug}-${i}`
		if (!taken.has(candidate)) return candidate
	}
	throw new Error(`unable to find a unique slug for "${baseSlug}" after 1000 attempts`)
}

async function uniqueArtifactSlug(projectId: string, baseSlug: string): Promise<string> {
	const existing = await db
		.select({ slug: artifacts.slug })
		.from(artifacts)
		.where(eq(artifacts.projectId, projectId))
	const taken = new Set(existing.map((r) => r.slug))
	if (!taken.has(baseSlug)) return baseSlug
	for (let i = 2; i < 1000; i++) {
		const candidate = `${baseSlug}-${i}`
		if (!taken.has(candidate)) return candidate
	}
	throw new Error(`unable to find a unique slug for "${baseSlug}" after 1000 attempts`)
}

// ─────────── Project CRUD ───────────

export type CreateProjectInput = {
	userId: string
	name: string
	description?: string | null
	kind?: ProjectKind
	slug?: string
}

export async function createProject(input: CreateProjectInput): Promise<ProjectRow> {
	const baseSlug = input.slug ? slugify(input.slug) : slugify(input.name)
	const slug = await uniqueProjectSlug(input.userId, baseSlug)
	const [row] = await db
		.insert(projects)
		.values({
			userId: input.userId,
			name: input.name,
			slug,
			description: input.description ?? null,
			kind: input.kind ?? 'other',
		})
		.returning()
	return row
}

export async function listProjects(userId: string): Promise<ProjectRow[]> {
	return db
		.select()
		.from(projects)
		.where(eq(projects.userId, userId))
		.orderBy(desc(projects.updatedAt))
}

export async function getProjectById(projectId: string): Promise<ProjectRow | null> {
	const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	return row ?? null
}

export async function getProjectBySlug(userId: string, slug: string): Promise<ProjectRow | null> {
	const [row] = await db
		.select()
		.from(projects)
		.where(and(eq(projects.userId, userId), eq(projects.slug, slug)))
		.limit(1)
	return row ?? null
}

export async function updateProject(
	projectId: string,
	patch: { name?: string; description?: string | null; kind?: ProjectKind },
): Promise<ProjectRow | null> {
	const updates: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() }
	if (patch.name !== undefined) updates.name = patch.name
	if (patch.description !== undefined) updates.description = patch.description
	if (patch.kind !== undefined) updates.kind = patch.kind
	const [row] = await db.update(projects).set(updates).where(eq(projects.id, projectId)).returning()
	return row ?? null
}

export async function deleteProject(projectId: string): Promise<{ deleted: boolean }> {
	// Cascade trims artifacts + versions automatically via FK.
	const result = await db.delete(projects).where(eq(projects.id, projectId)).returning({ id: projects.id })
	return { deleted: result.length > 0 }
}

// ─────────── Artifact CRUD + versions ───────────

export type CreateArtifactInput = {
	projectId: string
	name: string
	content: string
	contentType?: ArtifactContentType
	changeNote?: string | null
	editedBy?: string | null
	sourceRunId?: string | null
	costUsd?: number | string | null
}

export type ArtifactWithCurrent = ArtifactRow & {
	currentVersion: ArtifactVersionRow | null
}

/**
 * Create a new artifact in a project, seeding it with version 1 in a single transaction so the
 * artifact never exists without its initial version.
 */
export async function createArtifact(input: CreateArtifactInput): Promise<ArtifactWithCurrent> {
	const baseSlug = slugify(input.name)
	const slug = await uniqueArtifactSlug(input.projectId, baseSlug)

	return db.transaction(async (tx) => {
		const [artifact] = await tx
			.insert(artifacts)
			.values({
				projectId: input.projectId,
				name: input.name,
				slug,
				contentType: input.contentType ?? 'markdown',
			})
			.returning()
		const [version] = await tx
			.insert(artifactVersions)
			.values({
				artifactId: artifact.id,
				seq: 1,
				content: input.content,
				changeNote: input.changeNote ?? null,
				editedBy: input.editedBy ?? null,
				sourceRunId: input.sourceRunId ?? null,
				costUsd: input.costUsd != null ? String(input.costUsd) : null,
			})
			.returning()
		const [updated] = await tx
			.update(artifacts)
			.set({ currentVersionId: version.id, updatedAt: new Date() })
			.where(eq(artifacts.id, artifact.id))
			.returning()
		return { ...updated, currentVersion: version }
	})
}

export type EditArtifactInput = {
	artifactId: string
	content: string
	changeNote?: string | null
	editedBy?: string | null
	sourceRunId?: string | null
	costUsd?: number | string | null
}

/**
 * Append a new version to an existing artifact. Computes `seq = previousMax + 1` and updates
 * the artifact's `currentVersionId` pointer in the same transaction. Preserves all prior
 * versions — append-only.
 */
export async function editArtifact(input: EditArtifactInput): Promise<ArtifactVersionRow | null> {
	return db.transaction(async (tx) => {
		const [maxSeq] = await tx
			.select({ max: drizzleSql<number>`coalesce(max(${artifactVersions.seq}), 0)::int` })
			.from(artifactVersions)
			.where(eq(artifactVersions.artifactId, input.artifactId))
		const nextSeq = (maxSeq?.max ?? 0) + 1
		if (nextSeq === 1) {
			// Artifact has no versions yet — caller should be using createArtifact. Don't proceed.
			throw new Error(`editArtifact: artifact ${input.artifactId} has no existing version (use createArtifact)`)
		}
		const [version] = await tx
			.insert(artifactVersions)
			.values({
				artifactId: input.artifactId,
				seq: nextSeq,
				content: input.content,
				changeNote: input.changeNote ?? null,
				editedBy: input.editedBy ?? null,
				sourceRunId: input.sourceRunId ?? null,
				costUsd: input.costUsd != null ? String(input.costUsd) : null,
			})
			.returning()
		await tx
			.update(artifacts)
			.set({ currentVersionId: version.id, updatedAt: new Date() })
			.where(eq(artifacts.id, input.artifactId))
		return version
	})
}

export async function getArtifactById(artifactId: string): Promise<ArtifactWithCurrent | null> {
	const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
	if (!artifact) return null
	const [version] = artifact.currentVersionId
		? await db
				.select()
				.from(artifactVersions)
				.where(eq(artifactVersions.id, artifact.currentVersionId))
				.limit(1)
		: []
	return { ...artifact, currentVersion: version ?? null }
}

export async function listArtifactsForProject(
	projectId: string,
	opts: { includeInactive?: boolean } = {},
): Promise<ArtifactRow[]> {
	const filters = [eq(artifacts.projectId, projectId)]
	if (!opts.includeInactive) filters.push(eq(artifacts.isActive, true))
	return db
		.select()
		.from(artifacts)
		.where(and(...filters))
		.orderBy(desc(artifacts.updatedAt))
}

export async function getVersionHistory(artifactId: string): Promise<ArtifactVersionRow[]> {
	return db
		.select()
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, artifactId))
		.orderBy(asc(artifactVersions.seq))
}

export async function getVersion(versionId: string): Promise<ArtifactVersionRow | null> {
	const [row] = await db
		.select()
		.from(artifactVersions)
		.where(eq(artifactVersions.id, versionId))
		.limit(1)
	return row ?? null
}

/**
 * Non-destructive rollback: copies the target seq's content forward as a new version. The old
 * versions are preserved so the timeline reads "v1 → v2 → v3 (revert to v1) → v4".
 */
export async function rollbackArtifact(input: {
	artifactId: string
	toSeq: number
	editedBy?: string | null
	changeNote?: string | null
}): Promise<ArtifactVersionRow | null> {
	const [target] = await db
		.select()
		.from(artifactVersions)
		.where(and(eq(artifactVersions.artifactId, input.artifactId), eq(artifactVersions.seq, input.toSeq)))
		.limit(1)
	if (!target) return null
	return editArtifact({
		artifactId: input.artifactId,
		content: target.content,
		changeNote: input.changeNote ?? `Rollback to v${input.toSeq}`,
		editedBy: input.editedBy ?? null,
	})
}

/**
 * Soft-delete: marks an artifact as inactive. Versions are preserved; listArtifactsForProject
 * filters them out unless `includeInactive: true` is passed.
 */
export async function softDeleteArtifact(artifactId: string): Promise<{ deleted: boolean }> {
	const result = await db
		.update(artifacts)
		.set({ isActive: false, updatedAt: new Date() })
		.where(eq(artifacts.id, artifactId))
		.returning({ id: artifacts.id })
	return { deleted: result.length > 0 }
}
