import { query } from '$app/server'
import { z } from 'zod'
import { desc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { research } from '$lib/research/research.schema'
import { images } from '$lib/images/images.schema'

/**
 * Unified "recent output" feed for things the agent produced that live in the
 * database rather than on disk:
 *
 *   - completed research runs → kind: 'research'
 *   - generated images        → kind: 'image'
 *
 * This replaced the old /artifacts feed, which merged these two with a third
 * source — the `artifacts` table. Documents the agent writes are plain files in
 * the project working directory now, so the filesystem view owns them and this
 * feed only covers what has no file behind it.
 *
 * Each source is fetched in parallel, normalized into a discriminated union,
 * merged by `createdAt` desc, and trimmed to `limit`. The `type` filter narrows
 * the union to a single source so the UI's filter chips reuse the same query.
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

export type LibraryFeedItem = ResearchFeedItem | ImageFeedItem

const listInputSchema = z
	.object({
		limit: z.number().int().min(1).max(200).optional(),
		type: z.enum(['all', 'research', 'image']).optional(),
	})
	.default({})

export const listRecentOutputQuery = query(listInputSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const limit = input.limit ?? 60
	const type = input.type ?? 'all'

	const wantResearch = type === 'all' || type === 'research'
	const wantImage = type === 'all' || type === 'image'

	// Per-source over-fetch so the merged result still has `limit` items even when
	// one source dominates the feed.
	const perSourceLimit = Math.min(limit, 100)

	const [researchRows, imageRows] = await Promise.all([
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
			: Promise.resolve(
					[] as Array<{
						id: string
						query: string
						report: string | null
						status: string
						costUsd: string
						createdAt: Date
					}>,
				),
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
			: Promise.resolve(
					[] as Array<{
						id: string
						prompt: string
						url: string
						model: string
						size: string | null
						costUsd: string | null
						createdAt: Date
					}>,
				),
	])

	const items: LibraryFeedItem[] = []

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

	items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
	return items.slice(0, limit)
})
