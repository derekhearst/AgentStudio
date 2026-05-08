/**
 * Context-window utilization metrics shown in the ContextWindow strip on the chat page.
 *
 * Pure transformation: takes the visible message list, recorded message stats
 * (per-row token counts from the LLM), the live tokenizer-accurate total from
 * the SSE stream, and the model's own context limit, then returns the
 * percent-of-budget breakdown plus a per-model usage chart.
 *
 * Estimates fall back to chars/4 (estimateTokens) when no live count is
 * available — the very first prompt before the stream has reported.
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
	}>
	stats: Array<{
		id: string
		role: string
		model: string | null
		tokensOut: number
	}>
	messages: Array<{ id: string; content: string }>
	totalBudget: number
	liveTokenEstimate: number | null
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

export function computeContextMetrics(input: ContextMetricsInput): ContextMetrics {
	const { displayedMessages, stats, messages, totalBudget, liveTokenEstimate } = input

	const messageTokens = displayedMessages.reduce(
		(sum, message) => sum + estimateTokens(message.content),
		0,
	)

	const toolResultTokens = displayedMessages.reduce((sum, message) => {
		const calls = message.toolCalls ?? []
		for (const call of calls) {
			const resultText = typeof call.result === 'string' ? call.result : JSON.stringify(call.result ?? {})
			sum += estimateTokens(resultText)
		}
		return sum
	}, 0)

	const otherTokens = 0

	// Live SSE-supplied tokenizer-accurate count from the stream handler takes precedence
	// when available (Phase 7 of #4). Falls back to the chars/4-derived estimate above
	// for the very first prompt before the stream has reported.
	const used = Math.min(
		totalBudget,
		typeof liveTokenEstimate === 'number' && liveTokenEstimate > 0
			? liveTokenEstimate
			: SYSTEM_PROMPT_TOKEN_FLOOR + TOOL_DEFINITION_TOKEN_FLOOR + messageTokens + toolResultTokens + otherTokens,
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
			system: toPct(SYSTEM_PROMPT_TOKEN_FLOOR),
			tools: toPct(TOOL_DEFINITION_TOKEN_FLOOR),
			messages: toPct(messageTokens),
			results: toPct(toolResultTokens),
			other: toPct(otherTokens),
		},
		modelUsage,
	}
}
