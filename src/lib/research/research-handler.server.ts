import { z } from 'zod'
import { registerJobHandler } from '$lib/jobs/worker.server'
import { runResearchLoop } from './research-runner.server'

/**
 * Wave 4 #18 phase 3 — register the `research_run` job handler.
 *
 * Called once at boot from `db.server.ts` after migrations apply, alongside the other
 * registration hooks (built-in hooks, evaluator seed, etc.). The handler validates the
 * payload then delegates to `runResearchLoop` which owns the durable status transitions.
 *
 * The handler returns the orchestrator's outcome so the job's `result` jsonb captures the
 * final source/cited counts and total cost — admins can see this directly in the
 * `/settings/jobs` viewer alongside the trace in the research detail UI.
 */

const RESEARCH_RUN_PAYLOAD = z.object({
	researchId: z.string().uuid(),
})

let registered = false

export function registerResearchJobHandlers(): void {
	if (registered) return
	registerJobHandler('research_run', async ({ job, checkCancellation }) => {
		const parsed = RESEARCH_RUN_PAYLOAD.safeParse(job.payload)
		if (!parsed.success) {
			throw new Error(`research_run payload missing/invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
		}
		// Wave 4 #17 phase 3 — pass the worker's checkCancellation through so the runner can
		// bail at safe boundaries when the user clicks Cancel. The runner ALSO checks the
		// research row directly so a cancel via cancelResearchCommand is honored even if the
		// underlying job-cancel is racing.
		const outcome = await runResearchLoop(parsed.data.researchId, { checkCancellation })
		if (outcome.status === 'failed') {
			throw new Error(outcome.error ?? 'research run failed')
		}
		return {
			researchId: outcome.researchId,
			status: outcome.status,
			sourceCount: outcome.sourceCount,
			citedCount: outcome.citedCount,
			costUsd: outcome.costUsd,
		}
	})
	registered = true
}
