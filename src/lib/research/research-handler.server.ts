import { z } from 'zod'
import { registerJobHandler, type JobHandlerContext } from '$lib/jobs/worker.server'
import { runResearchLoop } from './research-runner.server'
import { getResearchById } from './research.server'
import { notifyUser } from '$lib/notifications/notify.server'
import { logger } from '$lib/observability/logger'

/**
 * Wave 4 #18 phase 3 — register the `research_run` job handler.
 *
 * Called once at boot from `db.server.ts` after migrations apply, alongside the other
 * registration hooks (built-in hooks, evaluator seed, etc.). The handler validates the
 * payload then delegates to `runResearchLoop` which owns the durable status transitions.
 *
 * On successful completion, fires a notification (in-app row + web push to subscribed
 * devices) so the user knows the cited report is ready — research runs can take 10-15 min
 * so the user is unlikely to be staring at the chat sidebar the whole time.
 *
 * The handler returns the orchestrator's outcome so the job's `result` jsonb captures the
 * final source/cited counts and total cost — admins can see this directly in the
 * `/settings/jobs` viewer alongside the trace in the research detail UI.
 *
 * How each outcome ends the job:
 *   - complete → the job completes, and the user is notified
 *   - canceled → the handler returns; the job was canceled with the research and stays so
 *   - failed   → the handler throws, so the job is recorded as failed. Research jobs get one
 *                attempt (`enqueueResearchRun`), so this is final rather than a silent re-run
 */

const RESEARCH_RUN_PAYLOAD = z.object({
	researchId: z.string().uuid(),
})

let registered = false

export async function runResearchJob({ job, checkCancellation }: JobHandlerContext) {
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

	// Notify on success — once, for the attempt that actually finished the report. Best-effort:
	// failures here never roll back the orchestrator.
	if (outcome.status === 'complete' && !outcome.alreadyFinished) {
		await fireCompletionNotification(outcome.researchId).catch((err) => {
			logger.warn('[research_run] notification dispatch failed (non-fatal)', { err })
		})
	}

	return {
		researchId: outcome.researchId,
		status: outcome.status,
		sourceCount: outcome.sourceCount,
		citedCount: outcome.citedCount,
		costUsd: outcome.costUsd,
	}
}

export function registerResearchJobHandlers(): void {
	if (registered) return
	registerJobHandler('research_run', runResearchJob)
	registered = true
}

async function fireCompletionNotification(researchId: string): Promise<void> {
	const r = await getResearchById(researchId)
	if (!r) return
	const queryShort = r.query.length > 120 ? `${r.query.slice(0, 117)}…` : r.query
	const payload = {
		title: 'Research complete',
		body: queryShort,
		url: `/research/${r.id}`,
		tag: `research:${r.id}`,
	}
	// In-app row plus web push, user-scoped so other users don't see someone else's research.
	// "Task completed" in Settings → Notifications switches both off.
	await notifyUser({ userId: r.userId, category: 'taskCompleted', payload })
}
