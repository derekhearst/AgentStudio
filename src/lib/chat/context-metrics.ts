/**
 * Context-window utilization metrics shown in the ContextWindow strip on the chat page.
 *
 * Pure transformation: takes the visible message list, recorded message stats
 * (per-row token counts from the LLM), the size of the system prompt the stream
 * reported, and the model's own context limit, then returns the percent-of-budget
 * breakdown plus a per-model usage chart.
 *
 * Every part is an estimate (chars/4, `estimateTokens`) except the system prompt, which
 * the stream measures when it assembles it.
 */

import { estimateTokens } from './streaming-blocks'

const SYSTEM_PROMPT_TOKEN_FLOOR = 900
const TOOL_DEFINITION_TOKEN_FLOOR = 900

const MODEL_PALETTE = [
	'var(--color-primary)',
	'var(--color-secondary)',
	'var(--color-accent)',
	'var(--color-info)',
] as const

export type ContextMetricsInput = {
	displayedMessages: Array<{
		id: string
		role: string
		content: string
		toolCalls?: Array<{ result?: unknown }>
		/** A saved reply's `metadata`; its `blocks` hold the turn's tool output. */
		metadata?: unknown
	}>
	stats: Array<{
		id: string
		role: string
		model: string | null
		tokensOut: number
	}>
	messages: Array<{ id: string; content: string }>
	totalBudget: number
	/**
	 * The assembled system prompt's size, from the stream's `context_stats` frame
	 * (`systemPromptTokens`). Null before any turn has streamed on this page.
	 *
	 * #78 — this used to arrive as `liveTokenEstimate` and REPLACE the whole figure, on the
	 * belief that it was a tokenizer-accurate count of the context. It is only the system
	 * prompt: since the Agent SDK, the history lives in the SDK session and never passes
	 * through the prompt assembly. So from the first turn on, a 150K-token conversation read
	 * as ~3K, and the model-switch auto-compact, which compares this figure to the smaller
	 * model's window, never fired. It now stands in for the system part only.
	 */
	systemPromptTokens: number | null
}

export type ContextMetrics = {
	total: number
	used: number
	breakdown: {
		system: number
		tools: number
		messages: number
		results: number
		other: number
	}
	modelUsage: Array<{ label: string; value: number; color: string }>
}

function resultTokens(result: unknown): number {
	return estimateTokens(typeof result === 'string' ? result : JSON.stringify(result ?? {}))
}

/**
 * Tool output recorded on a saved reply's blocks. A turn run through the Agent SDK saves
 * its calls there (with `toolCalls` left empty), and the output stays in the session's
 * context, so leaving it out made a tool-heavy conversation look nearly empty.
 */
function blockResultTokens(metadata: unknown): number {
	const blocks = metadata && typeof metadata === 'object' ? (metadata as { blocks?: unknown }).blocks : null
	if (!Array.isArray(blocks)) return 0
	let sum = 0
	for (const block of blocks) {
		if (block && typeof block === 'object' && (block as { kind?: unknown }).kind === 'tool') {
			sum += resultTokens((block as { result?: unknown }).result)
		}
	}
	return sum
}

export function computeContextMetrics(input: ContextMetricsInput): ContextMetrics {
	const { displayedMessages, stats, messages, totalBudget, systemPromptTokens } = input

	const messageTokens = displayedMessages.reduce(
		(sum, message) => sum + estimateTokens(message.content),
		0,
	)

	const toolResultTokens = displayedMessages.reduce((sum, message) => {
		for (const call of message.toolCalls ?? []) sum += resultTokens(call.result)
		return sum + blockResultTokens(message.metadata)
	}, 0)

	const otherTokens = 0

	const systemTokens =
		typeof systemPromptTokens === 'number' && systemPromptTokens > 0 ? systemPromptTokens : SYSTEM_PROMPT_TOKEN_FLOOR

	const used = Math.min(
		totalBudget,
		systemTokens + TOOL_DEFINITION_TOKEN_FLOOR + messageTokens + toolResultTokens + otherTokens,
	)

	const toPct = (value: number) =>
		totalBudget > 0 ? Math.max(0, Number(((value / totalBudget) * 100).toFixed(1))) : 0

	const modelTokenMap = new Map<string, number>()
	for (const row of stats) {
		if (row.role !== 'assistant') continue
		const modelLabel = (row.model ?? 'unknown').split('/').at(-1) ?? row.model ?? 'unknown'
		const modelTokens =
			row.tokensOut > 0 ? row.tokensOut : estimateTokens(messages.find((m) => m.id === row.id)?.content)
		modelTokenMap.set(modelLabel, (modelTokenMap.get(modelLabel) ?? 0) + modelTokens)
	}

	const modelTotal = [...modelTokenMap.values()].reduce((sum, value) => sum + value, 0)
	const modelUsage = [...modelTokenMap.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([label, value], idx) => ({
			label,
			value: modelTotal > 0 ? Number(((value / modelTotal) * 100).toFixed(1)) : 0,
			color: MODEL_PALETTE[idx % MODEL_PALETTE.length],
		}))

	return {
		total: totalBudget,
		used,
		breakdown: {
			system: toPct(systemTokens),
			tools: toPct(TOOL_DEFINITION_TOKEN_FLOOR),
			messages: toPct(messageTokens),
			results: toPct(toolResultTokens),
			other: toPct(otherTokens),
		},
		modelUsage,
	}
}
