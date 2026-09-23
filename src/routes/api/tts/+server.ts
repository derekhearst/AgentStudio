import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { synthesizeSpeech, TtsError } from '$lib/llm/tts.server'
import { logger } from '$lib/observability/logger'
import { requireAuth } from '$lib/server/api-route'
import { clientDisconnectSignal } from '$lib/server/client-disconnect'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { SPEECH_MODEL_ID_PATTERN, SPEECH_VOICE_PATTERN, TTS_MAX_CHARACTERS } from '$lib/speech/speech'

/**
 * POST /api/tts — synthesise one chunk of read-aloud text as MP3 (#27).
 *
 * The model and voice come from the caller's settings. `model` / `voice` in the body override
 * them for one request, which is how Settings previews a voice before it is saved. Longer
 * replies are split by the client (`splitForSpeech`) and sent one chunk at a time.
 *
 * Every refusal is JSON `{ message }` with a status, so the player can say what went wrong.
 * A listener who presses Stop closes the connection. If that happens before the call to
 * OpenRouter is made, the call is skipped; one already sent is finished and recorded, because
 * OpenRouter bills it either way (see tts.server.ts). `clientDisconnectSignal` is what notices:
 * the request's own signal never fires once the body has been read.
 */
const ttsRequestSchema = z.object({
	text: z
		.string({ error: 'Send the text to read aloud as "text".' })
		.trim()
		.min(1, 'There is no text to read aloud.')
		.max(TTS_MAX_CHARACTERS, `Text to read aloud is limited to ${TTS_MAX_CHARACTERS} characters per request.`),
	model: z.string().trim().max(120).regex(SPEECH_MODEL_ID_PATTERN, 'Speech model must be an OpenRouter model id').optional(),
	voice: z.string().trim().regex(SPEECH_VOICE_PATTERN, 'A voice name is up to 80 letters, digits, spaces and . _ : -').optional(),
	purpose: z.enum(['message', 'autoplay', 'preview']).optional(),
})

function refuse(status: number, message: string) {
	return json({ message }, { status })
}

export const POST = requireAuth(async ({ request, platform, user }) => {
	// JSON only. Cross-site form posts (text/plain, form encodings) never reach a paid call.
	if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
		return refuse(415, 'Send the text as JSON.')
	}
	let raw: unknown
	try {
		raw = await request.json()
	} catch {
		return refuse(400, 'The request body is not valid JSON.')
	}
	const parsed = ttsRequestSchema.safeParse(raw)
	if (!parsed.success) {
		return refuse(400, parsed.error.issues[0]?.message ?? 'Invalid read-aloud request.')
	}
	const payload = parsed.data

	const disconnect = clientDisconnectSignal({ request, platform })
	try {
		const settings = await getOrCreateSettings(user.id)
		const result = await synthesizeSpeech({
			text: payload.text,
			model: payload.model ?? settings.ttsModel,
			voice: payload.voice ?? settings.ttsVoice,
			purpose: payload.purpose,
			userId: user.id,
			signal: disconnect.signal,
		})
		return new Response(result.audio, {
			headers: {
				'Content-Type': result.contentType,
				'Content-Length': String(result.audio.byteLength),
				'Cache-Control': 'private, max-age=0, no-store',
				'X-TTS-Model': result.model,
				'X-TTS-Characters': String(result.characters),
			},
		})
	} catch (err) {
		if (err instanceof TtsError) return refuse(err.status, err.message)
		logger.error('[api/tts] synthesis failed', { err })
		return refuse(502, 'Read-aloud failed.')
	} finally {
		disconnect.dispose()
	}
})
