import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { chat, type LlmMessage } from '$lib/llm/chat.server'
import { logLlmUsage } from '$lib/costs/usage'
import { recordEvaluation } from './evaluations.server'
import type { RunEvaluationRow } from './evaluations.schema'
import { DEFAULT_EVALUATOR_AGENT_ID } from './evaluators-seed.server'
import { evaluatorResponseFormat, parseEvaluatorResponse, type ParsedEvaluatorResponse } from './evaluator-parse'
import { logger } from '$lib/observability/logger'

export { parseEvaluatorResponse, type ParsedEvaluatorResponse }

/**
 * Wave 3 #14 evaluations plan phase 2 — end-of-run evaluator pass.
 *
 * After a generator run completes (with `chat_runs.eval_required = true`), the chat handler
 * calls `runEvaluatorPass` to score the result. The evaluator is a single-shot LLM call (no
 * tools, no loop) using the seeded evaluator agent's system prompt + the generator's output.
 * The structured JSON response is parsed with Zod; parse failures degrade to `needs_revision`
 * with a single error finding so the re-plan loop (Phase 3) still has a signal to act on.
 *
 * Cost is logged via `logLlmUsage` with `source='evaluator'` so the existing per-agent /
 * per-run cost rollups surface evaluator spend separately. The evaluator's own `chat_runs`
 * row is intentionally NOT created here — single-shot synthesis doesn't need the full run
 * lifecycle, and skipping it keeps the `run_evaluations.evaluator_run_id` linkage optional.
 */

export type RunEvaluatorPassInput = {
	runId: string
	userId: string
	conversationId: string
	/** Original task / user message that prompted the generator run. */
	taskDescription: string
	/** What the generator produced — typically the assistant's final text output. */
	generatorOutput: string
	/** Optional: high-level summary of tools the generator called, for evaluator context. */
	toolSummary?: string
	/** Override the seeded evaluator agent — defaults to the first-party Default Evaluator. */
	evaluatorAgentId?: string
}

export async function runEvaluatorPass(input: RunEvaluatorPassInput): Promise<RunEvaluationRow | null> {
	const evaluatorAgentId = input.evaluatorAgentId ?? DEFAULT_EVALUATOR_AGENT_ID
	const [evaluator] = await db.select().from(agents).where(eq(agents.id, evaluatorAgentId)).limit(1)
	if (!evaluator) {
		logger.warn('[evaluations] evaluator agent missing — skipping pass', { runId: input.runId, evaluatorAgentId })
		return null
	}

	const userMessage = stringifyEvaluationContext({
		taskDescription: input.taskDescription,
		generatorOutput: input.generatorOutput,
		toolSummary: input.toolSummary,
	})

	const messages: LlmMessage[] = [
		{ role: 'system', content: evaluator.systemPrompt },
		{ role: 'user', content: userMessage },
	]

	let raw = ''
	let usage: { promptTokens?: number; completionTokens?: number } | undefined
	try {
		const result = await chat(messages, evaluator.model, {
			responseFormat: evaluatorResponseFormat,
			cache: { enabled: true, ttlSeconds: 1800 },
		})
		raw = result.content
		usage = result.usage
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err)
		return recordEvaluation({
			runId: input.runId,
			verdict: 'needs_revision',
			confidence: 0.1,
			findings: [{ severity: 'error', message: `evaluator LLM call failed: ${errorMessage}` }],
			evaluatorAgentId: evaluator.id,
			metadata: { provider: evaluator.model, fallbackReason: 'llm_error' },
		})
	}

	const parsed = parseEvaluatorResponse(raw)

	const cost = await logLlmUsage({
		source: 'evaluator',
		model: evaluator.model,
		tokensIn: usage?.promptTokens ?? 0,
		tokensOut: usage?.completionTokens ?? 0,
		userId: input.userId,
		runId: input.runId,
		agentId: evaluator.id,
		metadata: { conversationId: input.conversationId, evaluatedRunId: input.runId },
	}).catch(() => '0')

	const evaluationRow = await recordEvaluation({
		runId: input.runId,
		verdict: parsed.verdict,
		confidence: parsed.confidence,
		findings: parsed.findings,
		costUsd: cost,
		evaluatorAgentId: evaluator.id,
		metadata: {
			provider: evaluator.model,
			fallbackReason: parsed.fallback ?? null,
			rawResponse: parsed.fallback ? raw.slice(0, 1000) : undefined,
		},
	})

	// Wave 5 #20 phase 1 — open a review item when the verdict isn't `pass` so the user
	// has one inbox to triage non-clean evaluator outcomes. Best-effort: failure to open
	// the review item never blocks the evaluation row from being persisted.
	if (parsed.verdict !== 'pass') {
		void (async () => {
			try {
				const { openReviewItem } = await import('$lib/observability/review.server')
				await openReviewItem({
					type: 'evaluation_failure',
					severity: parsed.verdict === 'fail' ? 'critical' : 'warning',
					summary: `Evaluator returned ${parsed.verdict}${parsed.findings[0]?.message ? ` — ${parsed.findings[0].message.slice(0, 120)}` : ''}`,
					payload: {
						verdict: parsed.verdict,
						confidence: parsed.confidence,
						findingCount: parsed.findings.length,
						topFindings: parsed.findings.slice(0, 3),
					},
					runId: input.runId,
					sessionId: input.conversationId,
					dedupeKey: `eval:${input.runId}`,
				})
			} catch (err) {
				logger.warn('[evaluations] review item open failed (non-fatal)', { err })
			}
		})()
	}

	return evaluationRow
}

function stringifyEvaluationContext(input: {
	taskDescription: string
	generatorOutput: string
	toolSummary?: string
}): string {
	const parts = [
		`# User request\n\n${input.taskDescription.trim() || '(no task description provided)'}`,
		`# Generator output\n\n${input.generatorOutput.trim() || '(empty)'}`,
	]
	if (input.toolSummary?.trim()) {
		parts.push(`# Tools the generator called\n\n${input.toolSummary.trim()}`)
	}
	parts.push('Please evaluate the generator output against the user request and respond with the JSON verdict object.')
	return parts.join('\n\n')
}

