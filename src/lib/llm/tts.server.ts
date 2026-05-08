/**
 * OpenRouter text-to-speech client.
 *
 * Direct fetch to /api/v1/audio/speech. Returns raw audio bytes (mp3 default). Logs usage as
 * `tts` source with character-count tracking — TTS is billed per character, not per token, so
 * we use the `costOverride` path on logLlmUsage and compute the cost from the API response if
 * provided (or estimate from per-1K-char rates encoded in the model metadata).
 */

import { logLlmUsage } from '$lib/costs/usage'
import { logger } from '$lib/observability/logger'
import { requireOpenRouterApiKey } from '$lib/server/config'

const OPENROUTER_TTS_URL = 'https://openrouter.ai/api/v1/audio/speech'

export type TtsFormat = 'mp3' | 'wav' | 'flac' | 'opus' | 'pcm'

export type SynthesizeSpeechInput = {
	text: string
	model?: string
	voice: string
	format?: TtsFormat
	speed?: number
	userId?: string | null
	runId?: string | null
}

export type SynthesizeSpeechResult = {
	audio: Buffer
	contentType: string
	model: string
	characters: number
	costUsd: number | null
}

const DEFAULT_TTS_MODEL = 'openai/gpt-4o-mini-tts'

const MIME_BY_FORMAT: Record<TtsFormat, string> = {
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	flac: 'audio/flac',
	opus: 'audio/opus',
	pcm: 'audio/pcm',
}

export async function synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SynthesizeSpeechResult> {
	const apiKey = requireOpenRouterApiKey()
	const model = input.model ?? DEFAULT_TTS_MODEL
	const format = input.format ?? 'mp3'

	const body: Record<string, unknown> = {
		model,
		input: input.text,
		voice: input.voice,
		response_format: format,
	}
	if (typeof input.speed === 'number') body.speed = input.speed

	const response = await fetch(OPENROUTER_TTS_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`TTS request failed: ${response.status} ${response.statusText}: ${text.slice(0, 500)}`)
	}

	// Pricing/usage may arrive in the X-Generation-* headers OR a generation lookup; OpenRouter's
	// streaming TTS doesn't include a JSON envelope. Treat the response body as raw audio bytes.
	const arrayBuffer = await response.arrayBuffer()
	const audio = Buffer.from(arrayBuffer)
	const contentType = response.headers.get('content-type') ?? MIME_BY_FORMAT[format]
	const costHeader = response.headers.get('x-generation-cost')
	const costUsd = costHeader ? Number(costHeader) : null

	const characters = input.text.length

	void logLlmUsage({
		source: 'tts',
		model,
		tokensIn: characters,
		tokensOut: 0,
		costOverride: costUsd ?? undefined,
		userId: input.userId ?? null,
		runId: input.runId ?? null,
		metadata: { format, voice: input.voice, characters },
	}).catch((err) => {
		logger.warn('[tts] usage log failed', { err })
	})

	return { audio, contentType, model, characters, costUsd }
}
