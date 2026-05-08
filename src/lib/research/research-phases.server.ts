/**
 * Per-phase helpers for the deep-research orchestrator (`research-runner.server.ts`).
 *
 * Each phase is a small unit: drive an LLM (planner / reflection / synthesizer) or interact
 * with the web (search / fetch). They append the appropriate `research_steps` row + cost
 * ledger entry and return the data the orchestrator needs to advance.
 *
 * Behavior is identical to the inline versions that previously lived in research-runner.ts —
 * this is a pure code-organization refactor. The phases share no mutable state with the
 * orchestrator; they take all inputs as parameters.
 */

import { chat, type LlmMessage } from '$lib/llm/chat.server'
import { logLlmUsage } from '$lib/costs/usage'
import { webFetch, webSearch } from '$lib/tools/tools.server'
import { logger } from '$lib/observability/logger'
import {
	addResearchSource,
	addResearchStep,
} from './research.server'
import type { ResearchRow, ResearchSourceRow } from './research.schema'
import {
	buildSourcesPromptBlock,
	mapWithConcurrency,
	parsePlannerResponse,
	parseReflectionResponse,
	pickUrlsToFetch,
	type SearchHit,
} from './research-loop-helpers'
import type { ResolvedResearchConfig } from './research-config'
import { PLANNER_SYSTEM, REFLECTION_SYSTEM, SYNTHESIZER_SYSTEM } from './research-prompts'

const PARALLEL_FETCH_CONCURRENCY = 4

/**
 * Run a single search+fetch pass over a list of queries. Used for both the initial planner-
 * generated sub-questions and the reflection-generated gap queries. Fans out per-query work
 * with bounded concurrency so wall-clock stays sane even at the 12-sub-question hardcap.
 */
export async function runSearchAndFetchPass(
	researchId: string,
	queries: readonly string[],
	config: ResolvedResearchConfig,
	checkCanceled: () => Promise<void>,
): Promise<void> {
	await mapWithConcurrency(queries, PARALLEL_FETCH_CONCURRENCY, async (subQuestion) => {
		await checkCanceled()
		const hits = await runSearch(researchId, subQuestion).catch((err) => {
			logger.warn('[research] search failed', { researchId, subQuestion, err })
			return [] as SearchHit[]
		})
		const picked = pickUrlsToFetch(hits, config.urlsPerQuestion)
		// Within a sub-question, fetch URLs in parallel too — they're independent. Keeps total
		// in-flight bounded by PARALLEL_FETCH_CONCURRENCY × urlsPerQuestion (default 4×4 = 16),
		// well within Playwright's capacity.
		await Promise.all(
			picked.map((hit) =>
				runFetch(researchId, subQuestion, hit, config).catch((err) => {
					logger.warn('[research] fetch failed', { researchId, url: hit.url, err })
				}),
			),
		)
	})
}

export async function runPlanner(
	r: ResearchRow,
	config: ResolvedResearchConfig,
): Promise<{ subQuestions: string[]; raw: string; costUsd: number }> {
	const messages: LlmMessage[] = [
		{ role: 'system', content: PLANNER_SYSTEM },
		{ role: 'user', content: `Research query: ${r.query.trim()}\n\nReturn the JSON object now.` },
	]
	const result = await chat(messages, config.plannerModel)
	const cost = await logLlmUsage({
		source: 'evaluator', // research planning is advisor-tier work; reuses the existing source label
		model: config.plannerModel,
		tokensIn: result.usage?.promptTokens ?? 0,
		tokensOut: result.usage?.completionTokens ?? 0,
		userId: r.userId ?? null,
		runId: r.runId ?? null,
		metadata: { researchId: r.id, stage: 'plan' },
	}).catch(() => '0')

	const subQuestions = parsePlannerResponse(result.content).slice(0, config.maxSubQuestions)
	return { subQuestions, raw: result.content, costUsd: parseFloat(cost) || 0 }
}

async function runSearch(researchId: string, subQuestion: string): Promise<SearchHit[]> {
	const results = await webSearch(subQuestion, 8)
	const hits: SearchHit[] = results.map((r, idx) => ({
		url: r.url,
		title: r.title,
		snippet: r.snippet,
		rank: idx,
	}))
	await addResearchStep({
		researchId,
		kind: 'search',
		subQuestion,
		payload: { query: subQuestion, resultCount: hits.length },
		finishedAt: new Date(),
	})
	return hits
}

async function runFetch(
	researchId: string,
	subQuestion: string,
	hit: SearchHit,
	config: ResolvedResearchConfig,
): Promise<ResearchSourceRow | null> {
	const result = await webFetch(hit.url, config.maxFetchChars)
	const source = await addResearchSource({
		researchId,
		url: result.url,
		title: result.title || hit.title || null,
		extractedText: result.text,
		contentType: 'html',
	})
	await addResearchStep({
		researchId,
		kind: 'fetch',
		subQuestion,
		payload: {
			url: result.url,
			sourceId: source.id,
			charCount: result.text.length,
			truncated: result.truncated,
		},
		finishedAt: new Date(),
	})
	return source
}

export async function runReflection(
	r: ResearchRow,
	subQuestions: string[],
	sources: ResearchSourceRow[],
	config: ResolvedResearchConfig,
): Promise<{ gaps: string[]; raw: string; costUsd: number }> {
	if (sources.length === 0) {
		return { gaps: [], raw: '', costUsd: 0 }
	}
	const subQuestionsBlock = subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')
	// Per-source budget kept short on purpose: reflection only needs to know what was covered,
	// not the full content. 500 chars × ~32 sources ≈ 16k tokens of context — fits any model.
	const sourcesBlock = sources
		.map((src, i) => {
			const excerpt = (src.extractedText ?? '').slice(0, 500).replace(/\s+/g, ' ').trim()
			return `[${i + 1}] ${src.title ?? '(untitled)'} — ${src.url}\n    ${excerpt}`
		})
		.join('\n\n')

	const userMessage = `User query: ${r.query.trim()}

Sub-questions the planner decomposed it into:
${subQuestionsBlock}

Sources fetched so far (excerpt only):
${sourcesBlock}

What gaps remain? Return the JSON object now.`

	const messages: LlmMessage[] = [
		{ role: 'system', content: REFLECTION_SYSTEM },
		{ role: 'user', content: userMessage },
	]
	const result = await chat(messages, config.synthesizerModel)
	const cost = await logLlmUsage({
		source: 'evaluator',
		model: config.synthesizerModel,
		tokensIn: result.usage?.promptTokens ?? 0,
		tokensOut: result.usage?.completionTokens ?? 0,
		userId: r.userId ?? null,
		runId: r.runId ?? null,
		metadata: { researchId: r.id, stage: 'reflect' },
	}).catch(() => '0')

	const gaps = parseReflectionResponse(result.content)
	return { gaps, raw: result.content, costUsd: parseFloat(cost) || 0 }
}

export async function runSynthesizer(
	r: ResearchRow,
	subQuestions: string[],
	sources: ResearchSourceRow[],
	config: ResolvedResearchConfig,
): Promise<{ report: string; citationMap: Map<string, string>; costUsd: number }> {
	const { block, citationMap } = buildSourcesPromptBlock(sources)
	const subQuestionsBlock = subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')
	const userMessage = `User query: ${r.query.trim()}

Sub-questions to address:
${subQuestionsBlock}

Sources (cite as [N] inline):
${block}

Now produce the markdown report. Cite every claim with the source number it came from.`

	const messages: LlmMessage[] = [
		{ role: 'system', content: SYNTHESIZER_SYSTEM },
		{ role: 'user', content: userMessage },
	]
	const result = await chat(messages, config.synthesizerModel)
	const cost = await logLlmUsage({
		source: 'evaluator',
		model: config.synthesizerModel,
		tokensIn: result.usage?.promptTokens ?? 0,
		tokensOut: result.usage?.completionTokens ?? 0,
		userId: r.userId ?? null,
		runId: r.runId ?? null,
		metadata: { researchId: r.id, stage: 'synthesize' },
	}).catch(() => '0')

	return { report: result.content, citationMap, costUsd: parseFloat(cost) || 0 }
}
