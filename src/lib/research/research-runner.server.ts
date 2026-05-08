import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/sessions/sessions.schema'
import {
	addResearchStep,
	getResearchById,
	listSourcesForResearch,
	markSourcesCited,
	updateResearch,
} from './research.server'
import { logger } from '$lib/observability/logger'
import type { ResearchRow } from './research.schema'
import { extractCitedSourceIds } from './research-loop-helpers'
import {
	DEFAULT_RESEARCH_CONFIG,
	resolveResearchConfig,
	type ResolvedResearchConfig,
} from './research-config'
import {
	runPlanner,
	runReflection,
	runSearchAndFetchPass,
	runSynthesizer,
} from './research-phases.server'

/**
 * Deep Research orchestrator loop.
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
		// Pre-seeded plan path: when the research row already has sub-questions (e.g. the user
		// approved a plan artifact via request_plan_approval and the runner agent seeded the
		// research row), skip the planner LLM call and use the seed directly.
		let subQuestions: string[]
		if (Array.isArray(r.plan) && r.plan.length > 0) {
			subQuestions = r.plan
			await addResearchStep({
				researchId,
				kind: 'plan',
				payload: { phase: 'preapproved', subQuestions, source: 'user_approved' },
				costUsd: 0,
				finishedAt: new Date(),
			})
		} else {
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
			subQuestions = planResult.subQuestions
		}

		// ─────────── PHASE 2: SEARCH + FETCH (parallel fan-out) ───────────
		await checkCanceled()
		await updateResearch(researchId, { status: 'searching' })
		await runSearchAndFetchPass(researchId, subQuestions, config, checkCanceled)

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

			const reflection = await runReflection(r, subQuestions, sourcesSoFar, config)
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
		const synth = await runSynthesizer(r, subQuestions, sources, config)
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
			logger.warn('[research] config lookup failed, using defaults', { err })
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
