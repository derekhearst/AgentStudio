import { z } from 'zod'
import { registerJobHandler } from '$lib/jobs/worker.server'
import { runEvaluatorPass } from './evaluator-runner.server'

/**
 * Wave 4 #17 phase 5 — `evaluation_run` job handler.
 *
 * Migrates the previously inline fire-and-forget `void runEvaluatorPass(...)` call from the
 * chat-stream handler into a queued job. Same pattern as memory_mine: the work survives
 * restarts, dedupes across attempts, and surfaces failures in `/settings/jobs` instead of
 * silently swallowing in `console.warn`.
 *
 * Dedupe key is `eval:<runId>` — only one evaluator pass per run, even if the chat-stream
 * handler somehow fires the trigger twice (race conditions, retries). The handler returns
 * the verdict + finding count + cost so admins can inspect outcomes from the jobs viewer.
 */

const EVALUATION_RUN_PAYLOAD = z.object({
	runId: z.string().uuid(),
	userId: z.string().uuid(),
	conversationId: z.string().uuid(),
	taskDescription: z.string().min(1),
	generatorOutput: z.string(),
	toolSummary: z.string().optional(),
})

let registered = false

export function registerEvaluationJobHandlers(): void {
	if (registered) return
	registerJobHandler('evaluation_run', async ({ job }) => {
		const parsed = EVALUATION_RUN_PAYLOAD.safeParse(job.payload)
		if (!parsed.success) {
			throw new Error(`evaluation_run payload missing/invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
		}
		const result = await runEvaluatorPass({
			runId: parsed.data.runId,
			userId: parsed.data.userId,
			conversationId: parsed.data.conversationId,
			taskDescription: parsed.data.taskDescription,
			generatorOutput: parsed.data.generatorOutput,
			toolSummary: parsed.data.toolSummary,
		})
		if (!result) {
			// Evaluator agent missing or LLM call failed at the seed-lookup step; runEvaluatorPass
			// already records the issue in run_evaluations. Fail the job so it shows up in the
			// failures-only filter in /settings/jobs.
			throw new Error(`evaluator pass returned null for run ${parsed.data.runId}`)
		}
		return {
			runId: parsed.data.runId,
			verdict: result.verdict,
			confidence: result.confidence,
			findingCount: result.findings?.length ?? 0,
		}
	})
	registered = true
}
