/**
 * OpenRouter text-to-speech client (#27 — read-aloud).
 *
 * POSTs to /api/v1/audio/speech, which answers with raw audio bytes — no JSON envelope and no
 * cost header, only `X-Generation-Id`. Speech is billed per input character, and OpenRouter's
 * speech-model catalogue (`/api/v1/models?output_modalities=speech`) carries that price as
 * `pricing.prompt`. So spend is characters × catalogue price, checked against the user's
 * budget limits before the call and recorded under the `tts` ledger source after it.
 *
 * Every failure is a `TtsError` whose message is safe to show the user: the route passes it
 * through, so a wrong voice in Settings reads as the provider's own "Unknown voice …" rather
 * than a bare "TTS failed".
 */

import { checkBudgetLimits } from '$lib/costs/budget.server'
import { logLlmUsage } from '$lib/costs/usage'
import { logger } from '$lib/observability/logger'
import { getOpenRouterApiKey } from '$lib/server/config'
import { parseSpeechCatalog, TTS_MAX_CHARACTERS, type SpeechModel, type SpeechPurpose } from '$lib/speech/speech'

const OPENROUTER_TTS_URL = 'https://openrouter.ai/api/v1/audio/speech'
const OPENROUTER_SPEECH_MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=speech'

/** A long chunk takes a while to synthesise; a hung provider should not hold the request forever. */
const TTS_TIMEOUT_MS = 90_000
const CATALOG_TIMEOUT_MS = 15_000
const CATALOG_TTL_MS = 1000 * 60 * 60 // 1 hour, like the chat-model list
/** How much of a provider's error message reaches the user. Voice lists can be long. */
const PROVIDER_MESSAGE_MAX = 400

export class TtsError extends Error {
	/** HTTP status for the route to answer with. */
	readonly status: number
	constructor(status: number, message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'TtsError'
		this.status = status
	}
}

export type SynthesizeSpeechInput = {
	text: string
	model: string
	/** Empty or omitted: the model's own default voice. */
	voice?: string | null
	userId: string | null
	runId?: string | null
	purpose?: SpeechPurpose
	/** The caller's request signal, so a listener who presses Stop cancels the upstream call. */
	signal?: AbortSignal
}

export type SynthesizeSpeechResult = {
	audio: ArrayBuffer
	contentType: string
	model: string
	voice: string | null
	characters: number
	/** Estimated from the catalogue price; null when the model is not in the catalogue. */
	costUsd: number | null
}

let catalogCache: { at: number; models: SpeechModel[] } | null = null

/**
 * OpenRouter's speech models, with their per-character price and voices. Cached for an hour.
 * A failed refresh serves the stale list when there is one; with none it throws.
 */
export async function listSpeechModels(): Promise<SpeechModel[]> {
	if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.models
	try {
		const apiKey = getOpenRouterApiKey()
		const response = await fetch(OPENROUTER_SPEECH_MODELS_URL, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
		})
		if (!response.ok) throw new Error(`speech model catalogue answered HTTP ${response.status}`)
		const models = parseSpeechCatalog(await response.json())
		catalogCache = { at: Date.now(), models }
		return models
	} catch (err) {
		if (catalogCache) {
			logger.warn('[tts] speech model catalogue refresh failed; serving the cached list', { err })
			return catalogCache.models
		}
		throw err
	}
}

/**
 * What synthesising `characters` characters with `model` should cost, in USD. Null when the
 * catalogue cannot be read or does not list the model — pricing must never be the reason
 * speech fails, so an unknown price is recorded as unknown rather than refused.
 */
async function estimateSpeechCostUsd(model: string, characters: number): Promise<number | null> {
	try {
		const entry = (await listSpeechModels()).find((m) => m.id === model)
		return entry?.pricePerCharacter == null ? null : entry.pricePerCharacter * characters
	} catch (err) {
		logger.warn('[tts] could not price speech; recording it without a cost', { err, model })
		return null
	}
}

/** Pull `error.message` out of an OpenRouter error body, falling back to the raw text. */
function providerMessage(body: string): string {
	let message = body
	try {
		const parsed = JSON.parse(body) as { error?: { message?: unknown } }
		if (typeof parsed?.error?.message === 'string') message = parsed.error.message
	} catch {
		// not JSON — use the text as-is
	}
	message = message.replace(/\s+/g, ' ').trim()
	return message.length > PROVIDER_MESSAGE_MAX ? `${message.slice(0, PROVIDER_MESSAGE_MAX)}…` : message
}

/** Map a non-2xx provider answer to a status and a message the user can act on. */
async function upstreamFailure(response: Response): Promise<TtsError> {
	const body = await response.text().catch(() => '')
	const detail = providerMessage(body)
	logger.warn('[tts] provider refused speech request', { status: response.status, detail })
	switch (response.status) {
		case 400:
		case 404:
		case 422:
			// Almost always the model or voice in Settings: the provider names what it accepts.
			return new TtsError(422, `The speech provider rejected the request: ${detail || `HTTP ${response.status}`}`)
		case 401:
		case 403:
			return new TtsError(502, 'The speech provider rejected the OpenRouter API key.')
		case 402:
			return new TtsError(402, `OpenRouter could not bill this request: ${detail || 'insufficient credits'}`)
		case 429:
			return new TtsError(429, 'The speech provider is rate-limiting requests. Try again shortly.')
		default:
			return new TtsError(502, `The speech provider failed (HTTP ${response.status}).`)
	}
}

export async function synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SynthesizeSpeechResult> {
	const text = input.text.trim()
	if (!text) throw new TtsError(400, 'There is no text to read aloud.')
	if (text.length > TTS_MAX_CHARACTERS) {
		throw new TtsError(413, `Text to read aloud is limited to ${TTS_MAX_CHARACTERS} characters per request.`)
	}
	const apiKey = getOpenRouterApiKey()
	if (!apiKey) throw new TtsError(503, 'Read-aloud needs OPENROUTER_API_KEY, which is not set on this server.')

	const model = input.model
	const voice = input.voice?.trim() || null
	const characters = text.length
	const costUsd = await estimateSpeechCostUsd(model, characters)

	// Speech is paid, so it answers to the same budget limits a chat turn does.
	if (input.userId) {
		const budget = await checkBudgetLimits({ userId: input.userId, projectedCostUsd: costUsd ?? 0 })
		if (!budget.allowed && budget.blockedBy) {
			const limit = budget.blockedBy
			throw new TtsError(402, `Budget limit reached (${limit.scope} ${limit.period} limit of $${limit.limitUsd}).`)
		}
	}

	const body: Record<string, unknown> = { model, input: text, response_format: 'mp3' }
	if (voice) body.voice = voice

	const timeout = AbortSignal.timeout(TTS_TIMEOUT_MS)
	let response: Response
	let audio: ArrayBuffer
	try {
		response = await fetch(OPENROUTER_TTS_URL, {
			method: 'POST',
			headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: input.signal ? AbortSignal.any([timeout, input.signal]) : timeout,
		})
		if (!response.ok) throw await upstreamFailure(response)
		audio = await response.arrayBuffer()
	} catch (err) {
		if (err instanceof TtsError) throw err
		if (input.signal?.aborted) throw new TtsError(499, 'The request was cancelled.', { cause: err })
		if (timeout.aborted) throw new TtsError(504, 'The speech provider took too long to answer.', { cause: err })
		logger.warn('[tts] speech request failed', { err })
		throw new TtsError(502, 'Could not reach the speech provider.', { cause: err })
	}
	if (audio.byteLength === 0) throw new TtsError(502, 'The speech provider returned no audio.')

	void logLlmUsage({
		source: 'tts',
		model,
		// Speech is priced per character, so the ledger's "tokens in" counts characters here.
		tokensIn: characters,
		tokensOut: 0,
		// Zero rather than undefined when unpriced: the fallback prices from the chat-model
		// list, which has no speech models, and would record zero anyway after a network call.
		costOverride: costUsd ?? 0,
		userId: input.userId,
		runId: input.runId ?? null,
		metadata: {
			unit: 'characters',
			characters,
			voice,
			format: 'mp3',
			purpose: input.purpose ?? null,
			// False when the catalogue had no price for the model and the cost is recorded as 0.
			priced: costUsd !== null,
			generationId: response.headers.get('x-generation-id'),
		},
	}).catch((err) => {
		logger.warn('[tts] usage log failed', { err })
	})

	return {
		audio,
		contentType: response.headers.get('content-type') ?? 'audio/mpeg',
		model,
		voice,
		characters,
		costUsd,
	}
}
