/**
 * Artifact CRUD — append-only versioning scoped to a project or a conversation.
 *
 * Wave 4 #15 phase 1: every edit creates a new immutable version row. The
 * artifact carries a `currentVersionId` pointer that we bump in the same
 * transaction as the version insert, so a crash between leaves the artifact
 * pointing at a real, complete version. Rollback (not in this module) creates
 * a NEW version that copies the target seq's content forward — no version row
 * is ever mutated after insertion.
 *
 * Each artifact belongs to EXACTLY ONE of `projectId` or `conversationId` —
 * project-scoped artifacts are durable per-project work; conversation-scoped
 * are lightweight in-chat plans/todos/docs. The createArtifact contract
 * enforces this exclusivity.
 */

import { and, asc, desc, eq, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import {
	artifactVersions,
	artifacts,
	type ArtifactContentType,
	type ArtifactRow,
	type ArtifactVersionRow,
} from './projects.schema'
import { slugify } from './slug'

async function uniqueArtifactSlug(
	scope: { projectId: string } | { conversationId: string },
	baseSlug: string,
): Promise<string> {
	const where =
		'projectId' in scope
			? eq(artifacts.projectId, scope.projectId)
			: eq(artifacts.conversationId, scope.conversationId)
	const existing = await db.select({ slug: artifacts.slug }).from(artifacts).where(where)
	const taken = new Set(existing.map((r) => r.slug))
	if (!taken.has(baseSlug)) return baseSlug
	for (let i = 2; i < 1000; i++) {
		const candidate = `${baseSlug}-${i}`
		if (!taken.has(candidate)) return candidate
	}
	throw new Error(`unable to find a unique slug for "${baseSlug}" after 1000 attempts`)
}

export type CreateArtifactInput = {
	projectId?: string | null
	conversationId?: string | null
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
 * Create a new artifact, seeding it with version 1 in a single transaction so the artifact
 * never exists without its initial version. The artifact is scoped to either a project or a
 * conversation — exactly one must be supplied.
 */
export async function createArtifact(input: CreateArtifactInput): Promise<ArtifactWithCurrent> {
	if ((input.projectId == null) === (input.conversationId == null)) {
		throw new Error('createArtifact: exactly one of projectId or conversationId must be set')
	}

	const baseSlug = slugify(input.name)
	const slug = await uniqueArtifactSlug(
		input.projectId ? { projectId: input.projectId } : { conversationId: input.conversationId! },
		baseSlug,
	)

	return db.transaction(async (tx) => {
		const [artifact] = await tx
			.insert(artifacts)
			.values({
				projectId: input.projectId ?? null,
				conversationId: input.conversationId ?? null,
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

/**
 * List artifacts scoped to a conversation (lightweight in-chat plans/todos/docs).
 */
export async function listArtifactsForConversation(
	conversationId: string,
	opts: { includeInactive?: boolean } = {},
): Promise<ArtifactRow[]> {
	const filters = [eq(artifacts.conversationId, conversationId)]
	if (!opts.includeInactive) filters.push(eq(artifacts.isActive, true))
	return db
		.select()
		.from(artifacts)
		.where(and(...filters))
		.orderBy(desc(artifacts.updatedAt))
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
			throw new Error(
				`editArtifact: artifact ${input.artifactId} has no existing version (use createArtifact)`,
			)
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
