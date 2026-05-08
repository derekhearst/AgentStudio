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
type MessageContent = string | Array<TextContent | ImageContent>
type ReasoningDetail = Record<string, unknown>

export type ReasoningConfig = {
	enabled?: boolean
	exclude?: boolean
	effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
	maxTokens?: number
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

export async function chat(messages: LlmMessage[], model = DEFAULT_MODEL) {
	const client = getClient()
	const chatMessages = toChatMessages(messages)
	const result = await client.chat.send({
		chatRequest: {
			model,
			messages: chatMessages as never,
			stream: false,
		},
	})

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
	return client.chat.send({ chatRequest })
}
