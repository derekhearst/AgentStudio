import { error } from '@sveltejs/kit'
import { z } from 'zod'
import { synthesizeSpeech } from '$lib/llm/tts.server'
import { logger } from '$lib/observability/logger'
import { requireAuth } from '$lib/server/api-route'

const ttsRequestSchema = z.object({
	text: z.string().min(1).max(8000),
	voice: z.string().min(1).max(60).default('alloy'),
	model: z.string().min(1).max(120).optional(),
	format: z.enum(['mp3', 'wav', 'flac', 'opus', 'pcm']).optional(),
	speed: z.number().min(0.25).max(4).optional(),
})

export const POST = requireAuth(async ({ request, user }) => {
	let payload: z.infer<typeof ttsRequestSchema>
	try {
		const json = await request.json()
		payload = ttsRequestSchema.parse(json)
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : 'Invalid TTS request')
	}

	try {
		const result = await synthesizeSpeech({
			text: payload.text,
			voice: payload.voice,
			model: payload.model,
			format: payload.format,
			speed: payload.speed,
			userId: user.id,
		})
		const body = result.audio.buffer.slice(
			result.audio.byteOffset,
			result.audio.byteOffset + result.audio.byteLength,
		) as ArrayBuffer
		return new Response(body, {
			headers: {
				'Content-Type': result.contentType,
				'Content-Length': String(body.byteLength),
				'Cache-Control': 'private, max-age=0, no-store',
				'X-TTS-Model': result.model,
				'X-TTS-Characters': String(result.characters),
			},
		})
	} catch (err) {
		logger.error('[api/tts] synthesis failed', { err })
		throw error(502, 'TTS failed')
	}
})
