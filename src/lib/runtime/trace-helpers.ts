/**
 * Best-effort wrappers around the observability run-trace surface.
 *
 * The runtime opens a `run_traces` row at loop start so spans can append as
 * the loop progresses, and flips it to `completed` at the end. Both calls go
 * through dynamic imports so the runtime stays loadable in test contexts that
 * don't wire up observability — and both swallow errors with a warning so a
 * trace-write failure can never abort a chat run.
 */

import { logger } from '$lib/observability/logger'

/** Open a `run_traces` row tied to the conversation. Fire-and-forget. */
export function openRunTrace(input: { runId: string; conversationId: string }): void {
	void (async () => {
		try {
			const { startRunTrace } = await import('$lib/observability/traces.server')
			await startRunTrace({ runId: input.runId, sessionId: input.conversationId })
		} catch (err) {
			logger.warn('[runtime] startRunTrace failed (non-fatal)', { err })
		}
	})()
}

/** Flip the `run_traces` row to `completed`. Fire-and-forget. */
export function closeRunTrace(runId: string): void {
	void (async () => {
		try {
			const { finishRunTrace } = await import('$lib/observability/traces.server')
			await finishRunTrace({ runId, status: 'completed' })
		} catch (err) {
			logger.warn('[runtime] finishRunTrace failed (non-fatal)', { err })
		}
	})()
}
