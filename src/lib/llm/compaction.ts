import { chat, type LlmMessage } from '$lib/llm/openrouter'
import { estimateTokens, getContextWindowSize } from '$lib/llm/capabilities'
import { getOrCreateSettings } from '$lib/settings/settings'

const DEFAULT_COMPACTION_MODEL = 'openai/gpt-4o-mini'
const KEEP_RECENT_MESSAGES = 6
const MIN_MESSAGES_FOR_COMPACTION = 10

async function getCompactionModel(): Promise<string> {
	const settings = await getOrCreateSettings()
	const contextConfig = settings.contextConfig as { compactionModel?: string } | undefined
	return contextConfig?.compactionModel || DEFAULT_COMPACTION_MODEL
}

/**
 * Estimate total tokens for a message array.
 */
export function estimateMessageTokens(messages: LlmMessage[]): number {
	let total = 0
	for (const msg of messages) {
		if (typeof msg.content === 'string') {
			total += estimateTokens(msg.content) + 4 // role + overhead
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === 'text') {
					total += estimateTokens(block.text)
				} else {
					total += 200 // rough estimate for image references
				}
			}
			total += 4
		}
	}
	return total
}

/**
 * Check whether compaction should trigger for the given messages + model.
 * Uses the settings' autoCompactThresholdPct and the model's context window.
 */
export async function shouldCompact(
	messages: LlmMessage[],
	model: string,
): Promise<{ needed: boolean; tokenEstimate: number; threshold: number }> {
	const settings = await getOrCreateSettings()
	const contextConfig = settings.contextConfig as {
		reservedResponsePct?: number
		autoCompactThresholdPct?: number
	}

	const contextWindow = getContextWindowSize(model)
	const reservedPct = (contextConfig?.reservedResponsePct ?? 30) / 100
	const compactPct = (contextConfig?.autoCompactThresholdPct ?? 72) / 100

	// Usable context = total minus reserved response space
	const usableTokens = Math.floor(contextWindow * (1 - reservedPct))
	const threshold = Math.floor(usableTokens * compactPct)

	const tokenEstimate = estimateMessageTokens(messages)

	return {
		needed: tokenEstimate > threshold && messages.length >= MIN_MESSAGES_FOR_COMPACTION,
		tokenEstimate,
		threshold,
	}
}

/**
 * Compact a conversation by summarizing earlier messages and keeping
 * the most recent ones intact. Returns a new message array.
 */
export async function compactMessages(messages: LlmMessage[]): Promise<{
	compacted: LlmMessage[]
	summary: string
	originalTokens: number
	compactedTokens: number
}> {
	const originalTokens = estimateMessageTokens(messages)

	// Split: system messages stay, conversation gets split into early + recent
	const systemMessages = messages.filter((m) => m.role === 'system')
	const conversationMessages = messages.filter((m) => m.role !== 'system')

	// Keep the last N messages intact
	const keepCount = Math.min(KEEP_RECENT_MESSAGES, conversationMessages.length)
	const earlyMessages = conversationMessages.slice(0, -keepCount)
	const recentMessages = conversationMessages.slice(-keepCount)

	if (earlyMessages.length < 4) {
		// Not enough to compact — return original
		return { compacted: messages, summary: '', originalTokens, compactedTokens: originalTokens }
	}

	// Build the summarization prompt
	const earlyText = earlyMessages
		.map((m) => {
			const content = typeof m.content === 'string' ? m.content : '[multimodal content]'
			return `[${m.role}]: ${content.slice(0, 2000)}`
		})
		.join('\n\n')

	const compactionModel = await getCompactionModel()

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

	// Build the compacted message array
	const compacted: LlmMessage[] = [
		...systemMessages,
		{
			role: 'system',
			content: `[Conversation Summary — earlier messages were compacted to save context]\n\n${summary}`,
		},
		...recentMessages,
	]

	const compactedTokens = estimateMessageTokens(compacted)

	return { compacted, summary, originalTokens, compactedTokens }
}

/**
 * Trim tool results in the message history to reduce token usage.
 * Keeps the last `keepFull` tool results intact, replaces older ones with summaries.
 */
export function trimHistoricalToolResults(messages: LlmMessage[], keepFull = 3): LlmMessage[] {
	// Find all tool-role message indices
	const toolIndices: number[] = []
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === 'tool') {
			toolIndices.push(i)
		}
	}

	if (toolIndices.length <= keepFull) {
		return messages // Nothing to trim
	}

	// Indices of tool messages to trim (all except the last keepFull)
	const trimSet = new Set(toolIndices.slice(0, -keepFull))

	return messages.map((msg, i) => {
		if (!trimSet.has(i)) return msg

		const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
		const charCount = content.length
		const truncated = charCount > 200 ? content.slice(0, 100) + `... [${charCount} chars trimmed]` : content

		return { ...msg, content: truncated }
	})
}

/**
 * Trim a single tool result string if it exceeds the size limit.
 * Applied per-tool based on tool type.
 */
export function trimToolResult(toolName: string, resultStr: string): string {
	const limits: Record<string, number> = {
		web_search: 6000, // ~1500 tokens
		file_read: 32000, // ~8000 tokens
		shell: 16000, // ~4000 tokens
		browser_screenshot: Infinity, // base64 handled by provider
		memory_search: 8000,
		run_subagent: 16000,
	}

	const limit = limits[toolName] ?? 16000

	if (resultStr.length <= limit) return resultStr

	// Try to parse as JSON and trim intelligently
	try {
		const parsed = JSON.parse(resultStr)

		if (toolName === 'web_search' && Array.isArray(parsed)) {
			// Keep top 5 results, trim each snippet
			const trimmed = parsed.slice(0, 5).map((r: Record<string, unknown>) => ({
				...r,
				snippet: typeof r.snippet === 'string' ? r.snippet.slice(0, 500) : r.snippet,
				content: typeof r.content === 'string' ? r.content.slice(0, 500) : r.content,
			}))
			return JSON.stringify(trimmed)
		}

		// Generic: stringify and truncate
		const s = JSON.stringify(parsed)
		if (s.length > limit) {
			return s.slice(0, limit) + `\n... [truncated from ${s.length} chars]`
		}
		return s
	} catch {
		// Plain text — just truncate
		return resultStr.slice(0, limit) + `\n... [truncated from ${resultStr.length} chars]`
	}
}
