import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/sessions/sessions.schema'
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
	mapWithConcurrency,
	parsePlannerResponse,
	parseReflectionResponse,
	pickUrlsToFetch,
	type SearchHit,
} from './research-loop-helpers'
import { DEFAULT_RESEARCH_CONFIG, resolveResearchConfig, type ResolvedResearchConfig } from './research-config'

/**
 * Deep Research orchestrator loop (rebuilt).
 *
 * Drives a research run end-to-end:
 *   1. Plan: prompt LLM for sub-questions (saved into research.plan + a 'plan' step)
 *   2. Search + fetch IN PARALLEL: for each sub-question, web_search → score URLs →
 *      web_fetch top-K, fanned out with bounded concurrency.
 *   3. Reflect: prompt LLM with what was fetched and ask for follow-up gap queries.
 *      If non-empty, run a second search+fetch pass over those queries.
 *   4. Synthesize: prompt LLM with ALL source content (initial + gap-pass) + sub-questions,
 *      produce a thorough cited markdown report → flip cited_in_report on referenced sources.
 *   5. Mark complete + record finishedAt.
 *
 * Composer-selected model: when `research.model` is set (from startResearchCommand), that
 * value overrides DEFAULT_RESEARCH_CONFIG.{plannerModel,synthesizerModel} and the per-agent
 * resolved config. Used for both planner, reflection, and synthesizer phases.
 *
 * Failure paths transition status='failed' + write the error to research.error so the UI can
 * surface what went wrong. The runner never throws — every failure path is caught and
 * recorded so the calling job handler reports completion successfully.
 */

const PARALLEL_FETCH_CONCURRENCY = 4

const PLANNER_SYSTEM = `You are a research planner. Given a user's research query, decompose it into 4-8 specific, googleable sub-questions that together answer the query thoroughly.

Respond with ONLY a JSON object: {"subQuestions": ["question 1", "question 2", ...]}
- Sub-questions should be concrete and answerable by reading 1-3 web pages each.
- Avoid vague questions ("what is X?") in favor of specific ones ("what are the failure modes of X under condition Y?").
- Cover different angles: definitions, mechanisms, comparisons, evidence, edge cases, recent developments.
- No preamble, no markdown fences. Just the JSON object.`

const REFLECTION_SYSTEM = `You are a research evaluator. You're given the user's original query, the sub-questions a planner decomposed it into, and the sources fetched so far (titles + URLs + a short excerpt each).

Identify coverage gaps: claims that need more support, sub-questions thinly answered, perspectives missing, time-sensitive facts that need fresh sources, or contradictions worth resolving.

Emit follow-up search queries. Be concrete and Google-friendly — not "more on X" but "X failure rate 2024 study" or "Y vs Z benchmark site:arxiv.org".

Return ONLY a JSON object: {"gaps": ["query 1", "query 2", ...]}
- 0-4 queries. Empty array if coverage is genuinely complete.
- No preamble, no markdown fences.`

const SYNTHESIZER_SYSTEM = `You are a research synthesizer. You produce a thorough, cited markdown report from the sources provided. The user wants depth, not a summary.

Format:
- Executive summary (3-5 sentences) at the top.
- Then 4-8 thematic sections — organize by theme/argument, not strictly per sub-question. Cross-cutting analysis is the goal.
- Inline citations as [N] for every factual claim. Multiple citations [1][3] are encouraged when sources triangulate.
- Surface disagreement when sources contradict — don't flatten or pick silently. Quote briefly when the disagreement is sharp.
- Structure substantive claims as: claim → evidence → confidence ("established" / "contested" / "speculative").
- Call out gaps: what the sources couldn't answer, what fresh research would resolve.
- End with a "Sources" section listing each [N] you cited with title + URL.

Length: target 2000-4000 words for default-config runs. Don't pad — but don't truncate. The user picked Deep Research because they want a real report.

Hard rule: cite every factual claim. Don't make up facts not in the sources. If a sub-question can't be answered from the sources, say so explicitly.`

export type ResearchRunOutcome = {
	researchId: string
	status: 'complete' | 'failed' | 'canceled'
	report: string | null
	sourceCount: number
	citedCount: number
	costUsd: number
	error?: string | null
}

export type RunResearchLoopOptions = {
	/**
	 * Wave 4 #17 phase 3 — durable cancellation.
	 *
	 * Job handlers pass `ctx.checkCancellation` here so the loop can bail at safe boundaries
	 * (between planning/searching/synthesizing stages). When the underlying job has been
	 * canceled, `checkCancellation` throws — the loop catches, transitions research.status
	 * to `canceled`, and returns the outcome. Direct callers (tests, scripts) omit this and
	 * the loop runs to completion.
	 */
	checkCancellation?: () => Promise<void>
}

export async function runResearchLoop(
	researchId: string,
	opts: RunResearchLoopOptions = {},
): Promise<ResearchRunOutcome> {
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

	// Wave 4 #18 phase 4 — resolve per-agent research config if the research has a
	// conversationId with an attached agent. Falls back to defaults otherwise.
	const config = await resolveConfigForResearch(r)

	// Wave 4 #17 phase 3 — durable cancellation. Wraps `opts.checkCancellation` so the loop
	// can detect both the worker-side cancel signal AND a direct flip of research.status to
	// 'canceled' from the cancelResearchCommand path. Throws CanceledError on either.
	const checkCanceled = async () => {
		if (opts.checkCancellation) {
			await opts.checkCancellation()
		}
		const fresh = await getResearchById(researchId)
		if (fresh?.status === 'canceled') {
			throw new CanceledError(`research ${researchId} canceled`)
		}
	}

	try {
		// ─────────── PHASE 1: PLAN ───────────
		await checkCanceled()
		await updateResearch(researchId, { status: 'planning' })
		const planResult = await runPlanner(r, config)
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

		// ─────────── PHASE 2: SEARCH + FETCH (parallel fan-out) ───────────
		await checkCanceled()
		await updateResearch(researchId, { status: 'searching' })
		await runSearchAndFetchPass(researchId, planResult.subQuestions, config, checkCanceled)

		// ─────────── PHASE 2.5: ITERATIVE REFLECTION ───────────
		// Loop reflect → search-gaps until coverage saturates or we hit a cap. Each round asks
		// the LLM what's still missing given everything fetched so far, then runs a focused
		// search+fetch pass on those gap queries. Mirrors Claude Advanced Research's pattern of
		// repeated reflect-and-extend cycles instead of a single one-shot reflection pass.
		//
		// Stops early on any of: empty gap list, max-rounds reached, or maxTotalSources hit.
		// Each stop reason gets recorded as a 'plan' kind step with payload.phase = 'reflect-N'
		// so the trace UI can show why the loop terminated.
		for (let round = 1; round <= config.maxReflectionRounds; round++) {
			await checkCanceled()
			await updateResearch(researchId, { status: 'reflecting' })
			const sourcesSoFar = await listSourcesForResearch(researchId)

			// Source-cap check: bail if we've already hit the safety ceiling. Reflection adds
			// gaps × urlsPerQuestion sources, so we'd risk overshooting if we don't pre-check.
			if (sourcesSoFar.length >= config.maxTotalSources) {
				await addResearchStep({
					researchId,
					kind: 'plan',
					payload: {
						phase: `reflect-${round}`,
						stopReason: 'maxTotalSources',
						sourcesSoFar: sourcesSoFar.length,
					},
					finishedAt: new Date(),
				})
				break
			}

			const reflection = await runReflection(r, planResult.subQuestions, sourcesSoFar, config)
			totalCost += reflection.costUsd
			await addResearchStep({
				researchId,
				kind: 'plan',
				payload: {
					phase: `reflect-${round}`,
					gaps: reflection.gaps,
					rawResponse: reflection.raw.slice(0, 4000),
					sourcesSoFar: sourcesSoFar.length,
				},
				costUsd: reflection.costUsd,
				finishedAt: new Date(),
			})

			if (reflection.gaps.length === 0) {
				// Coverage complete per the LLM — no more gaps worth chasing.
				break
			}

			await checkCanceled()
			await updateResearch(researchId, { status: 'searching' })
			await runSearchAndFetchPass(researchId, reflection.gaps, config, checkCanceled)
		}

		// ─────────── PHASE 3: SYNTHESIZE ───────────
		await checkCanceled()
		await updateResearch(researchId, { status: 'synthesizing' })
		const sources = await listSourcesForResearch(researchId)
		if (sources.length === 0) {
			throw new Error('no sources fetched — cannot synthesize a report')
		}
		const synth = await runSynthesizer(r, planResult.subQuestions, sources, config)
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
		// Wave 4 #17 phase 3 — distinguish cancellation from failure. Canceled runs
		// transition to status='canceled' (not 'failed') and don't record err.message
		// as a research-row failure. The job handler also sees the throw and reports
		// completion with the canceled outcome.
		if (err instanceof CanceledError) {
			await updateResearch(researchId, {
				status: 'canceled',
				finishedAt: new Date(),
				costUsd: totalCost,
			})
			return {
				researchId,
				status: 'canceled',
				report: null,
				sourceCount: 0,
				citedCount: 0,
				costUsd: totalCost,
			}
		}
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

class CanceledError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CanceledError'
	}
}

// ─────────── Phase helpers ───────────

/**
 * Resolve the effective config for a research run. Priority:
 *   1. `research.model` from the composer (overrides planner+synthesizer model only)
 *   2. Per-agent `agents.config.research` (planner/synthesizer model + caps)
 *   3. DEFAULT_RESEARCH_CONFIG fallback
 *
 * The research row carries a conversationId; if that conversation has an attached agentId,
 * look up the agent's `config.research` and merge with defaults. Then apply the composer
 * model override if present.
 */
async function resolveConfigForResearch(r: ResearchRow): Promise<ResolvedResearchConfig> {
	let resolved: ResolvedResearchConfig = { ...DEFAULT_RESEARCH_CONFIG }
	if (r.conversationId) {
		try {
			const [conv] = await db
				.select({ agentId: conversations.agentId })
				.from(conversations)
				.where(eq(conversations.id, r.conversationId))
				.limit(1)
			if (conv?.agentId) {
				const [agent] = await db
					.select({ config: agents.config })
					.from(agents)
					.where(eq(agents.id, conv.agentId))
					.limit(1)
				if (agent) resolved = resolveResearchConfig(agent.config)
			}
		} catch (err) {
			console.warn('[research] config lookup failed, using defaults', err)
		}
	}
	// Composer-selected model takes precedence over both per-agent config and defaults.
	// Drives planner, reflection, AND synthesizer phases — single source of truth for the run.
	if (r.model && r.model.trim().length > 0) {
		resolved.plannerModel = r.model
		resolved.synthesizerModel = r.model
	}
	return resolved
}

/**
 * Run a single search+fetch pass over a list of queries. Used for both the initial planner-
 * generated sub-questions and the reflection-generated gap queries. Fans out per-query work
 * with bounded concurrency so wall-clock stays sane even at the 12-sub-question hardcap.
 */
async function runSearchAndFetchPass(
	researchId: string,
	queries: readonly string[],
	config: ResolvedResearchConfig,
	checkCanceled: () => Promise<void>,
): Promise<void> {
	await mapWithConcurrency(queries, PARALLEL_FETCH_CONCURRENCY, async (subQuestion) => {
		await checkCanceled()
		const hits = await runSearch(researchId, subQuestion).catch((err) => {
			console.warn('[research] search failed', { researchId, subQuestion, err })
			return [] as SearchHit[]
		})
		const picked = pickUrlsToFetch(hits, config.urlsPerQuestion)
		// Within a sub-question, fetch URLs in parallel too — they're independent. Keeps total
		// in-flight bounded by PARALLEL_FETCH_CONCURRENCY × urlsPerQuestion (default 4×4 = 16),
		// well within Playwright's capacity.
		await Promise.all(
			picked.map((hit) =>
				runFetch(researchId, subQuestion, hit, config).catch((err) => {
					console.warn('[research] fetch failed', { researchId, url: hit.url, err })
				}),
			),
		)
	})
}

async function runPlanner(
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
		payload: { url: result.url, sourceId: source.id, charCount: result.text.length, truncated: result.truncated },
		finishedAt: new Date(),
	})
	return source
}

async function runReflection(
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

async function runSynthesizer(
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
