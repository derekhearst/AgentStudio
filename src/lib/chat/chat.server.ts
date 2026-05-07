import { chat, type LlmMessage } from '$lib/llm/chat.server'
import { estimateTokens, estimateTokensForModel, getContextWindowSize } from '$lib/tools/tools'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { logLlmUsage } from '$lib/costs/usage'
import { findSafeSplitPoint as findSafeSplitPointPure } from '$lib/chat/compaction'

export { findSafeSplitPoint } from '$lib/chat/compaction'

type Message = { role: 'user' | 'assistant'; content: string }

const KEEP_RECENT_MESSAGES = 8
const MIN_MESSAGES_FOR_COMPACTION = 10


export async function generateTitle(messages: Message[]): Promise<string> {
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

/**
 * Per-message overhead the API adds on top of content tokens. Approximate; mirrors what
 * OpenAI/Anthropic clients commonly add for role + name + structural framing.
 */
const PER_MESSAGE_OVERHEAD = 4
/** Per tool_call structural overhead (id, type, function name, json wrapper). */
const PER_TOOL_CALL_OVERHEAD = 20

export function estimateMessageTokens(messages: LlmMessage[], model?: string): number {
	const tok = (text: string) => (model ? estimateTokensForModel(text, model) : estimateTokens(text))
	let total = 0
	for (const msg of messages) {
		total += PER_MESSAGE_OVERHEAD
		if (typeof msg.content === 'string') {
			total += tok(msg.content)
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === 'text') {
					total += tok(block.text)
				} else {
					total += 200 // image/multimodal placeholder
				}
			}
		}
		// Tool messages and assistant tool_calls add structural overhead the model encodes.
		if (msg.role === 'tool') {
			total += PER_TOOL_CALL_OVERHEAD
			if (typeof msg.toolCallId === 'string') total += tok(msg.toolCallId)
		}
		if (Array.isArray(msg.toolCalls)) {
			for (const call of msg.toolCalls) {
				total += PER_TOOL_CALL_OVERHEAD
				if (call.function?.name) total += tok(call.function.name)
				if (call.function?.arguments) total += tok(call.function.arguments)
			}
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

	const tokenEstimate = estimateMessageTokens(messages, model)

	return {
		needed: tokenEstimate > threshold && messages.length >= MIN_MESSAGES_FOR_COMPACTION,
		tokenEstimate,
		threshold,
	}
}

/**
 * Static compaction system prompt. Pulled out of the call site so the cacheControl marker
 * can engage on it — the same string ships on every compaction event, so caching it pays off
 * after the first compaction in any conversation history.
 */
const COMPACTION_SYSTEM_PROMPT = `You are a conversation summarizer. Produce a concise summary that preserves:
1. Key decisions and conclusions reached
2. Important facts, data, or context mentioned
3. Current task state and what remains to be done
4. Any tool calls that were made and the key results they produced (preserve tool names + outcomes)
5. User preferences, corrections, or explicit constraints they expressed

Write in third-person past tense. Output four sections in this exact order, using markdown headings:

## Decisions
## Key Facts
## Task State
## Tool Results

Be concise but don't lose critical details. Keep under 800 words total.`

export async function compactMessages(
	messages: LlmMessage[],
	_userId: string,
	model: string,
): Promise<{
	compacted: LlmMessage[]
	summary: string
	originalTokens: number
	compactedTokens: number
	summaryTokens: number
	compactionModel: string
}> {
	const originalTokens = estimateMessageTokens(messages, model)

	const systemMessages = messages.filter((m) => m.role === 'system')
	const conversationMessages = messages.filter((m) => m.role !== 'system')

	const desiredKeep = Math.min(KEEP_RECENT_MESSAGES, conversationMessages.length)
	const desiredSplit = Math.max(0, conversationMessages.length - desiredKeep)
	const safeSplit = findSafeSplitPointPure(conversationMessages, desiredSplit)

	const earlyMessages = conversationMessages.slice(0, safeSplit)
	const recentMessages = conversationMessages.slice(safeSplit)

	// If the safe-split rule pushed the boundary too far up to make summarization worthwhile,
	// or if there isn't enough history to summarize, skip compaction entirely.
	if (earlyMessages.length < 4) {
		return {
			compacted: messages,
			summary: '',
			originalTokens,
			compactedTokens: originalTokens,
			summaryTokens: 0,
			compactionModel: model,
		}
	}

	const earlyText = earlyMessages
		.map((m) => {
			const content = typeof m.content === 'string' ? m.content : '[multimodal content]'
			const toolCallSummary =
				m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0
					? ` [tool_calls: ${m.toolCalls.map((tc) => tc.function.name).join(', ')}]`
					: ''
			return `[${m.role}${toolCallSummary}]: ${content.slice(0, 2000)}`
		})
		.join('\n\n')

	// Always compact using the conversation's own model. Continuity matters more than the
	// per-event cost saving from a cheaper model, and the system prompt above gets cached
	// (cacheControl marker on the text block) so the per-event overhead is mostly read-cost
	// after the first compaction.
	const summaryResponse = await chat(
		[
			{
				role: 'system',
				content: [
					{
						type: 'text' as const,
						text: COMPACTION_SYSTEM_PROMPT,
						cacheControl: { type: 'ephemeral' as const },
					},
				],
			},
			{
				role: 'user',
				content: `Summarize this conversation history:\n\n${earlyText}`,
			},
		],
		model,
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

	const compactedTokens = estimateMessageTokens(compacted, model)
	const summaryTokens = estimateTokensForModel(summary, model)

	return {
		compacted,
		summary,
		originalTokens,
		compactedTokens,
		summaryTokens,
		compactionModel: model,
	}
}
