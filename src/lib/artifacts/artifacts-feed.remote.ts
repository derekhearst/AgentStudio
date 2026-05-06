import { query } from '$app/server'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { research } from '$lib/research/research.schema'
import { images } from '$lib/images/images.schema'
import { artifacts, artifactVersions, projects } from '$lib/projects/projects.schema'

/**
 * Unified "recent artifacts" feed.
 *
 * Aggregates three sources the agent produces:
 *
 *   - completed research runs       → kind: 'research'
 *   - generated images              → kind: 'image'
 *   - project artifacts (latest)    → kind: 'document'
 *
 * Each source is fetched in parallel, normalized into a discriminated union,
 * merged by `createdAt` desc, and trimmed to `limit`. The `type` filter narrows
 * the union to a single source so the UI's filter chips can reuse the same query.
 *
 * This module is deliberately separate from the project-scoped artifact CRUD in
 * `$lib/projects/projects.server.ts` — that module owns mutations against the
 * `artifacts` + `artifactVersions` tables. This one is read-only and feed-shaped.
 */

const PREVIEW_CHARS = 240

function preview(text: string | null | undefined): string {
	if (!text) return ''
	const flat = text.replace(/\s+/g, ' ').trim()
	if (flat.length <= PREVIEW_CHARS) return flat
	return `${flat.slice(0, PREVIEW_CHARS).trimEnd()}…`
}

export type ResearchFeedItem = {
	kind: 'research'
	id: string
	title: string
	preview: string
	status: string
	costUsd: string
	createdAt: Date
	href: string
}

export type ImageFeedItem = {
	kind: 'image'
	id: string
	title: string
	url: string
	model: string
	size: string | null
	costUsd: string | null
	createdAt: Date
}

export type DocumentFeedItem = {
	kind: 'document'
	id: string
	title: string
	preview: string
	contentType: string
	projectId: string
	projectName: string
	projectSlug: string
	artifactSlug: string
	createdAt: Date
	href: string
}

export type ArtifactFeedItem = ResearchFeedItem | ImageFeedItem | DocumentFeedItem

const listInputSchema = z
	.object({
		limit: z.number().int().min(1).max(200).optional(),
		type: z.enum(['all', 'research', 'image', 'document']).optional(),
	})
	.default({})

export const listRecentArtifactsQuery = query(listInputSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const limit = input.limit ?? 60
	const type = input.type ?? 'all'

	const wantResearch = type === 'all' || type === 'research'
	const wantImage = type === 'all' || type === 'image'
	const wantDocument = type === 'all' || type === 'document'

	// Per-source over-fetch so the merged result still has `limit` items even when
	// one source dominates the feed.
	const perSourceLimit = Math.min(limit, 100)

	const [researchRows, imageRows, documentRows] = await Promise.all([
		wantResearch
			? db
					.select({
						id: research.id,
						query: research.query,
						report: research.report,
						status: research.status,
						costUsd: research.costUsd,
						createdAt: research.createdAt,
					})
					.from(research)
					.where(eq(research.userId, user.id))
					.orderBy(desc(research.createdAt))
					.limit(perSourceLimit)
			: Promise.resolve([] as Array<{
					id: string
					query: string
					report: string | null
					status: string
					costUsd: string
					createdAt: Date
				}>),
		wantImage
			? db
					.select({
						id: images.id,
						prompt: images.prompt,
						url: images.url,
						model: images.model,
						size: images.size,
						costUsd: images.costUsd,
						createdAt: images.createdAt,
					})
					.from(images)
					.where(eq(images.userId, user.id))
					.orderBy(desc(images.createdAt))
					.limit(perSourceLimit)
			: Promise.resolve([] as Array<{
					id: string
					prompt: string
					url: string
					model: string
					size: string | null
					costUsd: string | null
					createdAt: Date
				}>),
		wantDocument
			? db
					.select({
						id: artifacts.id,
						name: artifacts.name,
						slug: artifacts.slug,
						contentType: artifacts.contentType,
						content: artifactVersions.content,
						versionCreatedAt: artifactVersions.createdAt,
						projectId: projects.id,
						projectName: projects.name,
						projectSlug: projects.slug,
						artifactUpdatedAt: artifacts.updatedAt,
					})
					.from(artifacts)
					.innerJoin(projects, eq(projects.id, artifacts.projectId))
					.leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
					.where(and(eq(projects.userId, user.id), eq(artifacts.isActive, true)))
					.orderBy(desc(artifacts.updatedAt))
					.limit(perSourceLimit)
			: Promise.resolve([] as Array<{
					id: string
					name: string
					slug: string
					contentType: string
					content: string | null
					versionCreatedAt: Date | null
					projectId: string
					projectName: string
					projectSlug: string
					artifactUpdatedAt: Date
				}>),
	])

	const items: ArtifactFeedItem[] = []

	for (const r of researchRows) {
		items.push({
			kind: 'research',
			id: r.id,
			title: r.query,
			preview: preview(r.report),
			status: r.status,
			costUsd: r.costUsd,
			createdAt: r.createdAt,
			href: `/research/${r.id}`,
		})
	}

	for (const img of imageRows) {
		items.push({
			kind: 'image',
			id: img.id,
			title: img.prompt,
			url: img.url,
			model: img.model,
			size: img.size,
			costUsd: img.costUsd,
			createdAt: img.createdAt,
		})
	}

	for (const d of documentRows) {
		items.push({
			kind: 'document',
			id: d.id,
			title: d.name,
			preview: preview(d.content),
			contentType: d.contentType,
			projectId: d.projectId,
			projectName: d.projectName,
			projectSlug: d.projectSlug,
			artifactSlug: d.slug,
			createdAt: d.versionCreatedAt ?? d.artifactUpdatedAt,
			href: `/projects/${d.projectId}/artifacts/${d.id}`,
		})
	}

	items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
	return items.slice(0, limit)
})
