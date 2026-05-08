/**
 * OpenRouter async video generation client.
 *
 * Wraps /api/v1/video/generations (Veo, Wan, etc.) which is asynchronous: submit a job, get a
 * job ID, poll until status === 'completed', then download from `unsigned_urls`.
 *
 * The persistence layer for jobs is intentionally NOT in this module — store the job record in
 * a `video_generation_jobs` table or in `tool_usage.metadata`. This module just speaks to
 * OpenRouter and returns shapes the caller can persist.
 */

import { logger } from '$lib/observability/logger'
import { requireOpenRouterApiKey } from '$lib/server/config'

const VIDEO_GENERATIONS_URL = 'https://openrouter.ai/api/v1/video/generations'

export type VideoGenStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type SubmitVideoGenInput = {
	model: string
	prompt: string
	resolution?: '480p' | '720p' | '1080p' | '4k'
	aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9'
	durationSeconds?: number
	seed?: number
	generateAudio?: boolean
	frameImages?: Array<{ url: string }>
	inputReferences?: Array<{ url: string; weight?: number }>
	callbackUrl?: string
}

export type VideoGenJob = {
	jobId: string
	status: VideoGenStatus
	model: string
	createdAt: string
	completedAt?: string | null
	unsignedUrls?: string[]
	error?: string | null
	cost?: number | null
	metadata?: Record<string, unknown>
}

function authHeaders() {
	return {
		Authorization: `Bearer ${requireOpenRouterApiKey()}`,
		'Content-Type': 'application/json',
	}
}

export async function submitVideoGenJob(input: SubmitVideoGenInput): Promise<VideoGenJob> {
	const body: Record<string, unknown> = {
		model: input.model,
		prompt: input.prompt,
	}
	if (input.resolution) body.resolution = input.resolution
	if (input.aspectRatio) body.aspect_ratio = input.aspectRatio
	if (typeof input.durationSeconds === 'number') body.duration = input.durationSeconds
	if (typeof input.seed === 'number') body.seed = input.seed
	if (typeof input.generateAudio === 'boolean') body.generate_audio = input.generateAudio
	if (input.frameImages && input.frameImages.length > 0) body.frame_images = input.frameImages
	if (input.inputReferences && input.inputReferences.length > 0) body.input_references = input.inputReferences
	if (input.callbackUrl) body.callback_url = input.callbackUrl

	const response = await fetch(VIDEO_GENERATIONS_URL, {
		method: 'POST',
		headers: authHeaders(),
		body: JSON.stringify(body),
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`Video gen submit failed (${response.status}): ${text.slice(0, 500)}`)
	}

	const json = (await response.json()) as {
		id?: string
		status?: VideoGenStatus
		created_at?: string
		model?: string
	}

	if (!json.id) {
		throw new Error('Video gen response missing job id')
	}

	return {
		jobId: json.id,
		status: json.status ?? 'pending',
		model: json.model ?? input.model,
		createdAt: json.created_at ?? new Date().toISOString(),
	}
}

export async function pollVideoGenJob(jobId: string): Promise<VideoGenJob> {
	const response = await fetch(`${VIDEO_GENERATIONS_URL}/${encodeURIComponent(jobId)}`, {
		method: 'GET',
		headers: authHeaders(),
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`Video gen poll failed (${response.status}): ${text.slice(0, 500)}`)
	}

	const json = (await response.json()) as {
		id?: string
		status?: VideoGenStatus
		created_at?: string
		completed_at?: string | null
		unsigned_urls?: string[]
		error?: string | null
		model?: string
		cost?: number | null
	}

	return {
		jobId: json.id ?? jobId,
		status: json.status ?? 'pending',
		model: json.model ?? '',
		createdAt: json.created_at ?? new Date().toISOString(),
		completedAt: json.completed_at ?? null,
		unsignedUrls: json.unsigned_urls,
		error: json.error,
		cost: json.cost ?? null,
	}
}

/**
 * Poll until the job reaches a terminal state (completed/failed) or `timeoutMs` elapses.
 * Returns the final VideoGenJob.
 */
export async function waitForVideoGenJob(
	jobId: string,
	options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<VideoGenJob> {
	const timeoutMs = options.timeoutMs ?? 5 * 60_000
	const pollIntervalMs = options.pollIntervalMs ?? 5_000
	const start = Date.now()

	while (true) {
		const job = await pollVideoGenJob(jobId)
		if (job.status === 'completed' || job.status === 'failed') return job
		if (Date.now() - start > timeoutMs) {
			logger.warn('[video-gen] poll timeout exceeded', { jobId, elapsedMs: Date.now() - start })
			return job
		}
		await new Promise((r) => setTimeout(r, pollIntervalMs))
	}
}
