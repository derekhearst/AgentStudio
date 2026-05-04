import { chat, type LlmMessage } from '$lib/llm/chat.server'
import { logLlmUsage } from '$lib/costs/usage'
import { webFetch, webSearch } from '$lib/tools/tools.server'
import {
	addResearchSource,
	addResearchStep,
	getResearchById,
	listSourcesForResearch,
	markSourcesCited,
	updateResearch,
} from './research.server'
import type { ResearchRow, ResearchSourceRow } from './research.schema'
import {
	buildSourcesPromptBlock,
	extractCitedSourceIds,
	parsePlannerResponse,
	pickUrlsToFetch,
	type SearchHit,
} from './research-loop-helpers'

/**
 * Wave 4 #18 phase 2 — research orchestrator loop.
 *
 * Drives a research run end-to-end:
 *   1. Plan: prompt cheap LLM for 2-5 sub-questions (saved into research.plan + a 'plan' step)
 *   2. Search + fetch: for each sub-question, web_search → score URLs → web_fetch top-K
 *      → store as researchSource rows + 'search'/'fetch' steps
 *   3. Synthesize: prompt LLM with all source content + sub-questions, generate markdown
 *      report with [N] citations → flip cited_in_report on referenced sources →
 *      store report on research.report + 'synthesize' step
 *   4. Mark complete + record finishedAt
 *
 * Failure paths transition status='failed' + write the error to research.error so the UI can
 * surface what went wrong. The runner never throws — every failure path is caught and
 * recorded so the calling job handler reports completion successfully (the failure shows up
 * in the research row, not in the job).
 */

const PLANNER_MODEL = 'openai/gpt-4o-mini'
const SYNTHESIZER_MODEL = 'openai/gpt-4o-mini'
const MAX_SUB_QUESTIONS = 5
const URLS_PER_QUESTION = 2
const MAX_FETCH_CHARS = 30_000

const PLANNER_SYSTEM = `You are a research planner. Given a user's research query, decompose it into 3-5 specific, googleable sub-questions that together answer the query.

Respond with ONLY a JSON object: {"subQuestions": ["question 1", "question 2", ...]}
- Sub-questions should be concrete and answerable by reading 1-3 web pages each.
- Avoid vague questions ("what is X?") in favor of specific ones ("what are the failure modes of X under condition Y?").
- No preamble, no markdown fences. Just the JSON object.`

const SYNTHESIZER_SYSTEM = `You are a research synthesizer. Given a user's query, a list of sub-questions, and a numbered set of source extracts, produce a markdown report that answers the query using ONLY information from the sources.

Format:
- Start with a 1-2 sentence executive summary.
- Then a section per sub-question with cited findings.
- Inline citations as [N] referring to the source numbers.
- End with a "Sources" section listing each [N] you cited.
- Do NOT make up facts not supported by the sources. If a sub-question can't be answered from the sources, say so explicitly.
- Be concise — prefer 800-1500 words.`

export type ResearchRunOutcome = {
	researchId: string
	status: 'complete' | 'failed' | 'canceled'
	report: string | null
	sourceCount: number
	citedCount: number
	costUsd: number
	error?: string | null
}

export async function runResearchLoop(researchId: string): Promise<ResearchRunOutcome> {
	const r = await getResearchById(researchId)
	if (!r) {
		return {
			researchId,
			status: 'failed',
			report: null,
			sourceCount: 0,
			citedCount: 0,
			costUsd: 0,
			error: `Research ${researchId} not found`,
		}
	}

	let totalCost = 0

	try {
		// ─────────── PHASE 1: PLAN ───────────
		await updateResearch(researchId, { status: 'planning' })
		const planResult = await runPlanner(r)
		totalCost += planResult.costUsd
		await addResearchStep({
			researchId,
			kind: 'plan',
			payload: { subQuestions: planResult.subQuestions, rawResponse: planResult.raw.slice(0, 4000) },
			costUsd: planResult.costUsd,
			finishedAt: new Date(),
		})
		if (planResult.subQuestions.length === 0) {
			throw new Error('planner returned no sub-questions')
		}
		await updateResearch(researchId, { plan: planResult.subQuestions })

		// ─────────── PHASE 2: SEARCH + FETCH ───────────
		await updateResearch(researchId, { status: 'searching' })
		for (const subQuestion of planResult.subQuestions) {
			const hits = await runSearch(researchId, subQuestion).catch((err) => {
				console.warn('[research] search failed', { researchId, subQuestion, err })
				return [] as SearchHit[]
			})
			const picked = pickUrlsToFetch(hits, URLS_PER_QUESTION)
			await updateResearch(researchId, { status: 'fetching' })
			for (const hit of picked) {
				await runFetch(researchId, subQuestion, hit).catch((err) => {
					console.warn('[research] fetch failed', { researchId, url: hit.url, err })
				})
			}
		}

		// ─────────── PHASE 3: SYNTHESIZE ───────────
		await updateResearch(researchId, { status: 'synthesizing' })
		const sources = await listSourcesForResearch(researchId)
		if (sources.length === 0) {
			throw new Error('no sources fetched — cannot synthesize a report')
		}
		const synth = await runSynthesizer(r, planResult.subQuestions, sources)
		totalCost += synth.costUsd
		const citedIds = extractCitedSourceIds(synth.report, synth.citationMap)
		await markSourcesCited(researchId, citedIds)
		await addResearchStep({
			researchId,
			kind: 'synthesize',
			payload: { reportLength: synth.report.length, citedCount: citedIds.length },
			costUsd: synth.costUsd,
			finishedAt: new Date(),
		})

		// ─────────── COMPLETE ───────────
		await updateResearch(researchId, {
			status: 'complete',
			report: synth.report,
			costUsd: totalCost,
			finishedAt: new Date(),
		})
		return {
			researchId,
			status: 'complete',
			report: synth.report,
			sourceCount: sources.length,
			citedCount: citedIds.length,
			costUsd: totalCost,
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err)
		await updateResearch(researchId, {
			status: 'failed',
			finishedAt: new Date(),
			error: errorMsg,
			costUsd: totalCost,
		})
		return {
			researchId,
			status: 'failed',
			report: null,
			sourceCount: 0,
			citedCount: 0,
			costUsd: totalCost,
			error: errorMsg,
		}
	}
}

// ─────────── Phase helpers ───────────

async function runPlanner(r: ResearchRow): Promise<{ subQuestions: string[]; raw: string; costUsd: number }> {
	const messages: LlmMessage[] = [
		{ role: 'system', content: PLANNER_SYSTEM },
		{ role: 'user', content: `Research query: ${r.query.trim()}\n\nReturn the JSON object now.` },
	]
	const result = await chat(messages, PLANNER_MODEL)
	const cost = await logLlmUsage({
		source: 'evaluator', // research planning is advisor-tier work; reuses the existing source label
		model: PLANNER_MODEL,
		tokensIn: result.usage?.promptTokens ?? 0,
		tokensOut: result.usage?.completionTokens ?? 0,
		userId: r.userId ?? null,
		runId: r.runId ?? null,
		metadata: { researchId: r.id, stage: 'plan' },
	}).catch(() => '0')

	const subQuestions = parsePlannerResponse(result.content).slice(0, MAX_SUB_QUESTIONS)
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

async function runFetch(researchId: string, subQuestion: string, hit: SearchHit): Promise<ResearchSourceRow | null> {
	const result = await webFetch(hit.url, MAX_FETCH_CHARS)
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
		payload: { url: result.url, sourceId: source.id, charCount: result.text.length, truncated: result.truncated },
		finishedAt: new Date(),
	})
	return source
}

async function runSynthesizer(
	r: ResearchRow,
	subQuestions: string[],
	sources: ResearchSourceRow[],
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
	const result = await chat(messages, SYNTHESIZER_MODEL)
	const cost = await logLlmUsage({
		source: 'evaluator',
		model: SYNTHESIZER_MODEL,
		tokensIn: result.usage?.promptTokens ?? 0,
		tokensOut: result.usage?.completionTokens ?? 0,
		userId: r.userId ?? null,
		runId: r.runId ?? null,
		metadata: { researchId: r.id, stage: 'synthesize' },
	}).catch(() => '0')

	return { report: result.content, citationMap, costUsd: parseFloat(cost) || 0 }
}
