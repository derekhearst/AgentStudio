import { OpenRouter } from '@openrouter/sdk'
import { env } from '$env/dynamic/private'

type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type LlmMessage = {
	role: ChatRole
	content: string
}

function toChatMessages(messages: LlmMessage[]) {
	return messages
		.filter((message) => message.role !== 'tool')
		.map((message) => ({
			role: message.role,
			content: message.content,
		})) as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
}

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4'
const MOCK_EXTERNALS = env.E2E_MOCK_EXTERNALS === '1'

let singleton: OpenRouter | null = null

function getClient() {
	if (MOCK_EXTERNALS) {
		throw new Error('OpenRouter client should not be used while E2E_MOCK_EXTERNALS=1')
	}
	if (!env.OPENROUTER_API_KEY) {
		throw new Error('OPENROUTER_API_KEY is not set')
	}

	if (!singleton) {
		singleton = new OpenRouter({
			apiKey: env.OPENROUTER_API_KEY,
		})
	}

	return singleton
}

export function getModelForTier(tier: 'fast' | 'powerful' | 'cheap') {
	if (tier === 'fast') return 'anthropic/claude-sonnet-4'
	if (tier === 'powerful') return 'anthropic/claude-opus-4'
	return 'openai/gpt-4o-mini'
}

export async function chat(messages: LlmMessage[], model = DEFAULT_MODEL) {
	if (MOCK_EXTERNALS) {
		const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
		return {
			content: `MOCK_RESPONSE: ${lastUserMessage.slice(0, 180)}`,
			usage: {
				promptTokens: 24,
				completionTokens: 18,
				totalTokens: 42,
			},
		}
	}

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

export async function streamChat(messages: LlmMessage[], model = DEFAULT_MODEL) {
	if (MOCK_EXTERNALS) {
		const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content ?? 'mock prompt'
		const content = `MOCK_STREAM: ${lastUserMessage.slice(0, 120)}`

		async function* mockStream() {
			yield {
				choices: [{ delta: { content } }],
				usage: {
					promptTokens: 20,
					completionTokens: 16,
					totalTokens: 36,
				},
			}
		}

		return mockStream()
	}

	const client = getClient()
	const chatMessages = toChatMessages(messages)
	return client.chat.send({
		chatRequest: {
			model,
			messages: chatMessages as never,
			stream: true,
		},
	})
}
