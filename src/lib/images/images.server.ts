import { db } from '$lib/db.server'
import { images, type ImageRow } from './images.schema'

/**
 * Generated-image persistence helpers.
 *
 * `recordGeneratedImage` is called from the `image_generate` tool handler right
 * after a successful provider response so the resulting image becomes a durable
 * audit row visible in the /research feed. Failures are swallowed by the
 * caller (image generation must succeed even if the audit insert fails).
 *
 * The /research feed reads the table itself (`$lib/research/library.remote`), scoped to
 * the signed-in user.
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
