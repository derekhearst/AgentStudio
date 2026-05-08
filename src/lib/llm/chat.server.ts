import { OpenRouter } from '@openrouter/sdk'

type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/**
 * Anthropic-style ephemeral cache marker. OpenRouter forwards this verbatim to Anthropic on
 * `anthropic/*` models. Up to 4 markers per request; caching is positional (tools → system →
 * messages, longest matching prefix). Other providers ignore the field.
 */
export type CacheControl = { type: 'ephemeral' }

type TextContent = { type: 'text'; text: string; cacheControl?: CacheControl }
type ImageContent = { type: 'image_url'; image_url: { url: string }; cacheControl?: CacheControl }
/**
 * OpenRouter file content block. Supports PDFs via base64 data URLs (`data:application/pdf;base64,...`)
 * or direct URLs. The optional `plugins: [{ id: 'file-parser', pdf: { engine } }]` request-level
 * field controls parser engine: `'native'` (model handles directly, e.g. Gemini 2.5),
 * `'mistral-ocr'` (per-page OCR for scanned docs), or `'pdf-text'` / Cloudflare default.
 */
type FileContent = {
	type: 'file'
	file: { filename: string; file_data: string }
	cacheControl?: CacheControl
}
/** Video input — model accepts mp4/webm/mov/mpeg via URL or base64 data URL. */
type VideoContent = {
	type: 'video_url'
	video_url: { url: string }
	cacheControl?: CacheControl
}
type MessageContent = string | Array<TextContent | ImageContent | FileContent | VideoContent>
type ReasoningDetail = Record<string, unknown>

export type ReasoningConfig = {
	enabled?: boolean
	exclude?: boolean
	effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
	maxTokens?: number
}

/**
 * OpenRouter JSON-schema response_format. Models that support strict mode (OpenAI GPT-4o+,
 * Anthropic Sonnet 4.5+/Opus 4.1+, Gemini, most open-source) return JSON validated against the
 * schema. Other models ignore the field — keep parser fallbacks.
 */
export type ResponseFormat = {
	type: 'json_schema'
	json_schema: {
		name: string
		strict?: boolean
		schema: Record<string, unknown>
	}
}

/**
 * OpenRouter plugins block — currently used for PDF parser engine selection. The `file-parser`
 * plugin's `pdf.engine` accepts:
 *   - `'native'` — the model handles the PDF directly (Gemini 2.5+, GPT-4o-file)
 *   - `'mistral-ocr'` — per-page OCR, best for scanned/image-heavy docs
 *   - `'pdf-text'` — Cloudflare default, fast text extraction
 */
export type ChatPlugin =
	| { id: 'file-parser'; pdf?: { engine?: 'native' | 'mistral-ocr' | 'pdf-text' } }
	| { id: string; [key: string]: unknown }

/**
 * Audio output config for audio-capable models (e.g. openai/gpt-4o-audio-preview). When set,
 * the request also needs `modalities: ['text', 'audio']`. Audio bytes stream via `delta.audio`
 * SSE chunks; the runtime accumulates them alongside the text transcript.
 */
export type AudioOutputConfig = {
	voice: string
	format: 'wav' | 'mp3' | 'pcm16' | 'flac' | 'opus'
}

/**
 * Optional per-call options bag. Lets us add new OpenRouter passthroughs (cache headers,
 * modalities, plugins) without growing the positional argument list.
 */
export type ChatOptions = {
	responseFormat?: ResponseFormat
	/** OpenRouter platform-level response cache. Distinct from Anthropic's prompt cache. */
	cache?: { enabled?: boolean; ttlSeconds?: number }
	/** Plugin slots — file parser engine, etc. */
	plugins?: ChatPlugin[]
	/** Output modalities. Default `['text']`; pass `['text','audio']` for spoken replies. */
	modalities?: Array<'text' | 'audio'>
	/** Audio output configuration. Required when `modalities` includes `'audio'`. */
	audio?: AudioOutputConfig
}

export type LlmMessage = {
	role: ChatRole
	content: MessageContent
	toolCallId?: string
	reasoning?: string | null
	reasoningDetails?: ReasoningDetail[]
	toolCalls?: Array<{
		id: string
		type: 'function'
		function: { name: string; arguments: string }
	}>
}

function toChatMessages(messages: LlmMessage[]) {
	return messages.map((message) => ({
		role: message.role,
		content: message.content,
		...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
		...(message.reasoning ? { reasoning: message.reasoning } : {}),
		...(message.reasoningDetails?.length ? { reasoningDetails: message.reasoningDetails } : {}),
		...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
	})) as Array<{ role: ChatRole; content: MessageContent }>
}

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4'

let singleton: OpenRouter | null = null

function getClient() {
	if (!process.env.OPENROUTER_API_KEY) {
		throw new Error('OPENROUTER_API_KEY is not set')
	}

	if (!singleton) {
		singleton = new OpenRouter({
			apiKey: process.env.OPENROUTER_API_KEY,
		})
	}

	return singleton
}

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * Cache-aware non-streaming chat. Uses raw fetch when `options.cache.enabled` is true so we can
 * attach OpenRouter's `X-OpenRouter-Cache` header (the SDK doesn't expose per-call headers).
 * Returns the same shape the SDK does — camelCase usage fields — so existing callers don't change.
 */
async function chatViaFetch(
	chatRequest: Record<string, unknown>,
	cache: NonNullable<ChatOptions['cache']>,
): Promise<{ content: string; usage?: { promptTokens?: number; completionTokens?: number } }> {
	if (!process.env.OPENROUTER_API_KEY) {
		throw new Error('OPENROUTER_API_KEY is not set')
	}
	const headers: Record<string, string> = {
		Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
		'Content-Type': 'application/json',
	}
	if (cache.enabled) {
		headers['X-OpenRouter-Cache'] = 'true'
		if (cache.ttlSeconds && cache.ttlSeconds > 0) {
			headers['X-OpenRouter-Cache-TTL'] = String(Math.floor(cache.ttlSeconds))
		}
	}
	const response = await fetch(OPENROUTER_CHAT_URL, {
		method: 'POST',
		headers,
		body: JSON.stringify(chatRequest),
	})
	if (!response.ok) {
		const body = await response.text()
		throw new Error(`Chat request failed: ${response.status} ${response.statusText}: ${body}`)
	}
	const json = (await response.json()) as {
		choices?: Array<{ message?: { content?: string } }>
		usage?: { prompt_tokens?: number; completion_tokens?: number }
	}
	return {
		content: json.choices?.[0]?.message?.content ?? '',
		usage: {
			promptTokens: json.usage?.prompt_tokens,
			completionTokens: json.usage?.completion_tokens,
		},
	}
}

export async function chat(messages: LlmMessage[], model = DEFAULT_MODEL, options: ChatOptions = {}) {
	const chatMessages = toChatMessages(messages)
	const chatRequest: Record<string, unknown> = {
		model,
		messages: chatMessages,
		stream: false,
	}
	if (options.responseFormat) {
		chatRequest.response_format = options.responseFormat
	}
	if (options.plugins && options.plugins.length > 0) {
		chatRequest.plugins = options.plugins
	}

	// Cache-enabled calls go via raw fetch so we can attach the OpenRouter caching headers.
	if (options.cache?.enabled) {
		return chatViaFetch(chatRequest, options.cache)
	}

	const client = getClient()
	const result = await client.chat.send({ chatRequest: chatRequest as never })

	const choice = result.choices?.[0]
	return {
		content: choice?.message?.content ?? '',
		usage: result.usage,
	}
}

/**
 * Tool definition shape passed to streamChat. The optional `cacheControl` field on the last
 * entry tells Anthropic (via OpenRouter) to cache the tools prefix; ignored by other providers.
 *
 * Note: this is the OpenRouter SDK's INPUT shape (camelCase). The SDK converts to the wire
 * shape `cache_control` (snake_case) at serialization time.
 */
export type ChatTool = {
	type: string
	function: { name: string; description: string; parameters: Record<string, unknown> }
	cacheControl?: CacheControl
}

export async function streamChat(
	messages: LlmMessage[],
	model = DEFAULT_MODEL,
	tools?: ChatTool[],
	reasoning?: ReasoningConfig,
	options: ChatOptions = {},
) {
	const client = getClient()
	const chatMessages = toChatMessages(messages)
	// `usage: { include: true }` asks OpenRouter to surface detailed usage (including Anthropic
	// prompt-caching metrics) on the final stream chunk. The SDK's typed surface doesn't expose
	// this passthrough field; we mutate the request after construction so TypeScript still
	// narrows to the streaming overload via the literal `stream: true`.
	const chatRequest = {
		model,
		messages: chatMessages as never,
		stream: true as const,
		...(tools && tools.length > 0 ? { tools: tools as never } : {}),
		...(reasoning ? { reasoning } : {}),
	}
	;(chatRequest as Record<string, unknown>).usage = { include: true }
	if (options.responseFormat) {
		;(chatRequest as Record<string, unknown>).response_format = options.responseFormat
	}
	if (options.plugins && options.plugins.length > 0) {
		;(chatRequest as Record<string, unknown>).plugins = options.plugins
	}
	if (options.modalities && options.modalities.length > 0) {
		;(chatRequest as Record<string, unknown>).modalities = options.modalities
	}
	if (options.audio) {
		;(chatRequest as Record<string, unknown>).audio = options.audio
	}
	return client.chat.send({ chatRequest })
}
