/**
 * Media-generation tool handlers: image_generate (Flux/SDXL/DALL-E via OpenRouter)
 * and video_generate (Veo/Wan via OpenRouter async video jobs).
 *
 * Both handlers route the cost ledger entry through `logToolUsage` so the per-tool
 * spend rolls up alongside chat token costs. `image_generate` also persists the
 * generated image to the /artifacts feed; the persist is best-effort and never
 * blocks the agent's report-back.
 */

import { toolSchemas } from '../tool-schemas'
import { generateImage } from '../image-gen.server'
import { resolveConversationFromRunId } from '../artifact-scope.server'
import { logger } from '$lib/observability/logger'
import type { ToolHandler } from '../handler-types'

export const mediaHandlers: Record<string, ToolHandler> = {
	video_generate: async (call, { userId, runId, startedAt }) => {
		const input = toolSchemas.video_generate.parse(call.arguments)
		const { submitVideoGenJob, waitForVideoGenJob } = await import('$lib/llm/video-generation.server')
		const submitted = await submitVideoGenJob({
			model: input.model,
			prompt: input.prompt,
			resolution: input.resolution,
			aspectRatio: input.aspectRatio,
			durationSeconds: input.durationSeconds,
			seed: input.seed,
			generateAudio: input.generateAudio,
		})
		const final = await waitForVideoGenJob(submitted.jobId, {
			timeoutMs: input.timeoutSeconds * 1000,
			pollIntervalMs: 5000,
		})
		const completed =
			final.status === 'completed' &&
			Array.isArray(final.unsignedUrls) &&
			final.unsignedUrls.length > 0
		if (completed && typeof final.cost === 'number' && final.cost > 0) {
			try {
				const { logToolUsage } = await import('$lib/costs/usage')
				await logToolUsage({
					toolName: 'video_generate',
					provider: 'openrouter',
					unitType: 'second',
					units: input.durationSeconds,
					cost: final.cost,
					userId,
					runId: runId ?? null,
					metadata: { model: input.model, resolution: input.resolution, jobId: final.jobId },
				})
			} catch (err) {
				logger.warn('[tools] video_generate cost log failed', { err })
			}
		}
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
		// Record the generated image so it appears in the /artifacts feed.
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
