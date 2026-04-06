import { chat, type LlmMessage } from '$lib/openrouter.server'
import { estimateTokens, getContextWindowSize } from '$lib/tools/tools'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { logLlmUsage } from '$lib/cost/usage'

type Message = { role: 'user' | 'assistant'; content: string }

const DEFAULT_COMPACTION_MODEL = 'openai/gpt-4o-mini'
const KEEP_RECENT_MESSAGES = 6
const MIN_MESSAGES_FOR_COMPACTION = 10

function isMockExternalsEnabled(): boolean {
	return process.env.E2E_MOCK_EXTERNALS === '1'
}

export async function generateTitle(messages: Message[]): Promise<string> {
	if (isMockExternalsEnabled()) {
		return 'Mock conversation'
	}

	const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 400)}`).join('\n')

	const titleModel = 'openai/gpt-4o-mini'
	const response = await chat(
		[
			{
				role: 'system',
				content:
					'You generate short, descriptive conversation titles. Respond with only the title, no punctuation at the end, no quotes.',
			},
			{
				role: 'user',
				content: `Write a concise 3-8 word title for this conversation:\n\n${transcript}`,
			},
		],
		titleModel,
	)

	void logLlmUsage({
		source: 'titlegen',
		model: titleModel,
		tokensIn: response.usage?.promptTokens ?? 0,
		tokensOut: response.usage?.completionTokens ?? 0,
	}).catch(() => {})

	const title = (response.content ?? '')
		.trim()
		.replace(/^["']|["']$/g, '')
		.slice(0, 120)
	return title || 'Untitled conversation'
}

export async function generateTitleAndCategory(messages: Message[]): Promise<{ title: string; category: string }> {
	if (isMockExternalsEnabled()) {
		return { title: 'Mock conversation', category: 'general' }
	}

	const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 400)}`).join('\n')

	const catModel = 'openai/gpt-4o-mini'
	const response = await chat(
		[
			{
				role: 'system',
				content:
					'You label conversations with a short title and a freeform category. Respond with valid JSON only: {"title":"...","category":"..."}. The title should be 3-8 words. The category should be 1-3 words that best describes the topic. No wrapping text, no markdown.',
			},
			{
				role: 'user',
				content: `Label this conversation:\n\n${transcript}`,
			},
		],
		catModel,
	)

	void logLlmUsage({
		source: 'titlegen',
		model: catModel,
		tokensIn: response.usage?.promptTokens ?? 0,
		tokensOut: response.usage?.completionTokens ?? 0,
	}).catch(() => {})

	try {
		const raw = response.content
			.trim()
			.replace(/^```json\s*|^```\s*|```$/g, '')
			.trim()
		const parsed = JSON.parse(raw) as { title?: string; category?: string }
		return {
			title: (parsed.title ?? '').trim().slice(0, 120) || 'Untitled conversation',
			category: (parsed.category ?? '').trim().toLowerCase().slice(0, 60) || 'general',
		}
	} catch {
		return { title: 'Untitled conversation', category: 'general' }
	}
}

async function getCompactionModel(userId: string): Promise<string> {
	const settings = await getOrCreateSettings(userId)
	const contextConfig = settings.contextConfig as { compactionModel?: string } | undefined
	return contextConfig?.compactionModel || DEFAULT_COMPACTION_MODEL
}

export function estimateMessageTokens(messages: LlmMessage[]): number {
	let total = 0
	for (const msg of messages) {
		if (typeof msg.content === 'string') {
			total += estimateTokens(msg.content) + 4
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === 'text') {
					total += estimateTokens(block.text)
				} else {
					total += 200
				}
			}
			total += 4
		}
	}
	return total
}

export async function shouldCompact(
	messages: LlmMessage[],
	model: string,
userId: string,
): Promise<{ needed: boolean; tokenEstimate: number; threshold: number }> {
	const settings = await getOrCreateSettings(userId)
	const contextConfig = settings.contextConfig as {
		reservedResponsePct?: number
		autoCompactThresholdPct?: number
	}

	const contextWindow = getContextWindowSize(model)
	const reservedPct = (contextConfig?.reservedResponsePct ?? 30) / 100
	const compactPct = (contextConfig?.autoCompactThresholdPct ?? 72) / 100

	const usableTokens = Math.floor(contextWindow * (1 - reservedPct))
	const threshold = Math.floor(usableTokens * compactPct)

	const tokenEstimate = estimateMessageTokens(messages)

	return {
		needed: tokenEstimate > threshold && messages.length >= MIN_MESSAGES_FOR_COMPACTION,
		tokenEstimate,
		threshold,
	}
}

export async function compactMessages(messages: LlmMessage[], userId: string): Promise<{
	compacted: LlmMessage[]
	summary: string
	originalTokens: number
	compactedTokens: number
}> {
	const originalTokens = estimateMessageTokens(messages)

	const systemMessages = messages.filter((m) => m.role === 'system')
	const conversationMessages = messages.filter((m) => m.role !== 'system')

	const keepCount = Math.min(KEEP_RECENT_MESSAGES, conversationMessages.length)
	const earlyMessages = conversationMessages.slice(0, -keepCount)
	const recentMessages = conversationMessages.slice(-keepCount)

	if (earlyMessages.length < 4) {
		return { compacted: messages, summary: '', originalTokens, compactedTokens: originalTokens }
	}

	const earlyText = earlyMessages
		.map((m) => {
			const content = typeof m.content === 'string' ? m.content : '[multimodal content]'
			return `[${m.role}]: ${content.slice(0, 2000)}`
		})
		.join('\n\n')

	const compactionModel = await getCompactionModel(userId)

	const summaryResponse = await chat(
		[
			{
				role: 'system',
				content: `You are a conversation summarizer. Produce a concise summary that preserves:
1. Key decisions and conclusions reached
2. Important facts, data, or context mentioned
3. Current task state and what remains to be done
4. Any tool results or artifacts that were created
5. User preferences or corrections expressed

Write in third-person past tense. Be concise but don't lose critical details. Keep under 800 words.`,
			},
			{
				role: 'user',
				content: `Summarize this conversation history:\n\n${earlyText}`,
			},
		],
		compactionModel,
	)

	const summary = summaryResponse.content as string

	const compacted: LlmMessage[] = [
		...systemMessages,
		{
			role: 'system',
			content: `[Conversation Summary - earlier messages were compacted to save context]\n\n${summary}`,
		},
		...recentMessages,
	]

	const compactedTokens = estimateMessageTokens(compacted)

	return { compacted, summary, originalTokens, compactedTokens }
}
