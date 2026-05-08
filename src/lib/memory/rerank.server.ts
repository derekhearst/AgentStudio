/**
 * Optional LLM rerank stage for retrieval.
 *
 * Given the top-N candidates from `recall()`, ask a reader model to promote
 * the single best drawer. Mirrors MemPalace's hybrid-v4 + LLM rerank step.
 */

import { z } from 'zod'
import { chat, type ResponseFormat } from '$lib/llm/chat.server'
import { logLlmUsage } from '$lib/costs/usage'
import type { RetrievedDrawer } from '$lib/memory/retrieval.server'
import { logger } from '$lib/observability/logger'

const DEFAULT_RERANK_MODEL = 'anthropic/claude-haiku-4.5'

const RERANK_SYSTEM = `You are a re-ranking judge for a memory retrieval system.
You will receive a question and a numbered list of candidate memory snippets.
Return STRICT JSON: { "rankedIds": [<id>, <id>, ...] } listing the candidate
ids from most-relevant to least-relevant. Do not include any other fields.`

const rerankSchema = z.object({
	rankedIds: z.array(z.string()),
})

const rerankResponseFormat: ResponseFormat = {
	type: 'json_schema',
	json_schema: {
		name: 'memory_rerank',
		strict: true,
		schema: z.toJSONSchema(rerankSchema) as Record<string, unknown>,
	},
}

export type RerankOptions = {
	model?: string
	keepTopK?: number
}

function safeParseRanked(text: string): string[] | null {
	const cleaned = text
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/i, '')
	try {
		const parsed = JSON.parse(cleaned)
		if (parsed && Array.isArray(parsed.rankedIds)) {
			return parsed.rankedIds.map((value: unknown) => String(value))
		}
	} catch {
		/* swallow */
	}
	return null
}

export async function rerank(
	question: string,
	candidates: RetrievedDrawer[],
	options: RerankOptions = {},
): Promise<RetrievedDrawer[]> {
	if (candidates.length <= 1) return candidates
	const model = options.model ?? DEFAULT_RERANK_MODEL
	const keepTopK = options.keepTopK ?? 5

	const numbered = candidates
		.map(
			(drawer, i) =>
				`[${i}] (id=${drawer.drawerId}) wing=${drawer.wingName} room=${drawer.roomLabel} topic=${drawer.closetTopic}\n${drawer.content}`,
		)
		.join('\n\n')

	try {
		const result = await chat(
			[
				{ role: 'system', content: RERANK_SYSTEM },
				{
					role: 'user',
					content: `Question:\n${question}\n\nCandidates:\n${numbered}\n\nReturn JSON: { "rankedIds": [...] }`,
				},
			],
			model,
			{ responseFormat: rerankResponseFormat, cache: { enabled: true, ttlSeconds: 1800 } },
		)

		await logLlmUsage({
			source: 'memory_rerank',
			model,
			tokensIn: result.usage?.promptTokens ?? 0,
			tokensOut: result.usage?.completionTokens ?? 0,
			metadata: { candidates: candidates.length },
		}).catch(() => undefined)

		const text = typeof result.content === 'string' ? result.content : ''
		const rankedIds = safeParseRanked(text)
		if (!rankedIds || rankedIds.length === 0) return candidates.slice(0, keepTopK)
		const byId = new Map(candidates.map((c) => [c.drawerId, c]))
		const ordered: RetrievedDrawer[] = []
		for (const id of rankedIds) {
			const found = byId.get(id)
			if (found) {
				ordered.push(found)
				byId.delete(id)
			}
		}
		// Append any candidate the model omitted, preserving original order
		for (const remaining of candidates) {
			if (byId.has(remaining.drawerId)) ordered.push(remaining)
		}
		return ordered.slice(0, keepTopK)
	} catch (error) {
		logger.warn('[memory] rerank failed; returning original order', { err: error })
		return candidates.slice(0, keepTopK)
	}
}
