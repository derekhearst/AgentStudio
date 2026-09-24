/**
 * Media-generation tool handlers: image_generate (Flux/SDXL/DALL-E via OpenRouter)
 * and video_generate (Veo/Wan via OpenRouter async video jobs).
 *
 * Both handlers put their spend in the tool ledger (`$lib/costs/media-spend.server`) so
 * it rolls up alongside chat token costs and counts against budget limits. A video job is
 * recorded when it is submitted and priced when it finishes — here, from the poll route,
 * or from the reconcile job, whichever sees it first. `image_generate` also persists the
 * generated image to the /research feed; the persist is best-effort and never blocks the
 * agent's report-back.
 */

import { toolSchemas } from '../tool-schemas'
import { generateImage } from '../image-gen.server'
import { resolveConversationFromRunId } from '../run-scope.server'
import { logger } from '$lib/observability/logger'
import type { ToolHandler } from '../handler-types'

export const mediaHandlers: Record<string, ToolHandler> = {
	video_generate: async (call, { userId, runId, startedAt }) => {
		const input = toolSchemas.video_generate.parse(call.arguments)
		const { submitVideoGenJob, waitForVideoGenJob } = await import('$lib/llm/video-generation.server')
		const { recordVideoJobSubmitted, settleVideoJobCost } = await import('$lib/costs/media-spend.server')
		const submitted = await submitVideoGenJob({
			model: input.model,
			prompt: input.prompt,
			resolution: input.resolution,
			aspectRatio: input.aspectRatio,
			durationSeconds: input.durationSeconds,
			seed: input.seed,
			generateAudio: input.generateAudio,
		})
		// Recorded before the wait: a job that outlasts it is still billed when it finishes,
		// and the reconcile job needs to know it exists to price it then.
		await recordVideoJobSubmitted({
			jobId: submitted.jobId,
			model: input.model,
			resolution: input.resolution,
			durationSeconds: input.durationSeconds,
			userId,
			runId: runId ?? null,
		}).catch((err) => logger.warn('[tools] video_generate ledger row failed', { err }))
		const final = await waitForVideoGenJob(submitted.jobId, {
			timeoutMs: input.timeoutSeconds * 1000,
			pollIntervalMs: 5000,
		})
		await settleVideoJobCost(final).catch((err) => logger.warn('[tools] video_generate cost log failed', { err }))
		const completed =
			final.status === 'completed' &&
			Array.isArray(final.unsignedUrls) &&
			final.unsignedUrls.length > 0
		return {
			success: completed,
			tool: call.name,
			input,
			result: {
				jobId: final.jobId,
				status: final.status,
				urls: final.unsignedUrls ?? [],
				pollUrl: completed ? null : `/api/video-jobs/${final.jobId}`,
				error: final.error ?? null,
				cost: final.cost ?? null,
			},
			executionMs: Date.now() - startedAt,
		}
	},

	image_generate: async (call, { userId, runId, startedAt }) => {
		const input = toolSchemas.image_generate.parse(call.arguments)
		const result = await generateImage(input.prompt, input.model, input.size)
		// The spend goes in the tool ledger, which is what budgets and /costs add up. It used
		// to live only on the images row, where neither looks.
		try {
			const { logImageGenerationSpend } = await import('$lib/costs/media-spend.server')
			await logImageGenerationSpend({
				cost: result.cost,
				model: result.model,
				size: result.size,
				userId,
				runId: runId ?? null,
			})
		} catch (err) {
			logger.warn('[tools] image_generate cost log failed', { err })
		}
		// Record the generated image so it appears in the /research feed.
		// Best-effort: failures here must NOT bubble up — the image was generated
		// successfully and the model needs to see the URL even if our audit insert
		// fails (DB hiccup, transient issue, …).
		try {
			const { recordGeneratedImage } = await import('$lib/images/images.server')
			const conversationId = await resolveConversationFromRunId(runId ?? null)
			await recordGeneratedImage({
				userId,
				conversationId,
				runId: runId ?? null,
				prompt: result.prompt,
				model: result.model,
				size: result.size,
				url: result.url,
				costUsd: result.cost,
			})
		} catch (err) {
			logger.warn('[tools] recordGeneratedImage failed (non-fatal)', { err })
		}
		return {
			success: true,
			tool: call.name,
			input,
			result,
			executionMs: Date.now() - startedAt,
		}
	},
}
