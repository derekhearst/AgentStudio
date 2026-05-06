import { and, desc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { images, type ImageRow } from './images.schema'

/**
 * Generated-image persistence helpers.
 *
 * `recordGeneratedImage` is called from the `image_generate` tool handler right
 * after a successful provider response so the resulting image becomes a durable
 * audit row visible in the /artifacts feed. Failures are swallowed by the
 * caller (image generation must succeed even if the audit insert fails).
 *
 * `listImagesForUser` powers the /artifacts feed.
 */

export type RecordGeneratedImageInput = {
	userId: string | null
	conversationId?: string | null
	runId?: string | null
	prompt: string
	model: string
	size?: string | null
	url: string
	costUsd?: number | string | null
}

export async function recordGeneratedImage(input: RecordGeneratedImageInput): Promise<ImageRow> {
	const [row] = await db
		.insert(images)
		.values({
			userId: input.userId,
			conversationId: input.conversationId ?? null,
			runId: input.runId ?? null,
			prompt: input.prompt,
			model: input.model,
			size: input.size ?? null,
			url: input.url,
			costUsd: input.costUsd != null ? String(input.costUsd) : null,
		})
		.returning()
	return row
}

export async function listImagesForUser(
	userId: string,
	opts: { limit?: number } = {},
): Promise<ImageRow[]> {
	return db
		.select()
		.from(images)
		.where(eq(images.userId, userId))
		.orderBy(desc(images.createdAt))
		.limit(opts.limit ?? 50)
}

export async function getImageById(imageId: string): Promise<ImageRow | null> {
	const [row] = await db.select().from(images).where(eq(images.id, imageId)).limit(1)
	return row ?? null
}

export async function getImageForUser(userId: string, imageId: string): Promise<ImageRow | null> {
	const [row] = await db
		.select()
		.from(images)
		.where(and(eq(images.id, imageId), eq(images.userId, userId)))
		.limit(1)
	return row ?? null
}
