import { z } from 'zod'
import { registerJobHandler } from '$lib/jobs/worker.server'
import { registerScheduledJob } from '$lib/jobs/scheduler.server'
import { runAutomationById, checkAndRunAutomations } from './engine'

/**
 * Wave 4 #17 phase 5 finish — `automation_run` job handler + dispatch tick.
 *
 * Migrates automation execution from inline (cron route called runAutomation directly) to
 * the durable queue:
 *   - The dispatch tick (`automations:dispatch`) runs every minute via the in-process
 *     scheduler. It reuses `checkAndRunAutomations` which now ENQUEUES jobs for each due
 *     automation instead of running them inline.
 *   - The `automation_run` handler picks up the per-automation job and calls
 *     `runAutomationById` which delegates to the existing runAutomation pipeline + updates
 *     last_run_at / next_run_at on success.
 *
 * Benefits: ticks survive restart, per-automation dedupe via `automation:<id>:<minute>`
 * prevents double-execution within the same tick window, failures show up in
 * `/settings/jobs` for forensics.
 *
 * The cron route (`/api/cron`) still works as an external trigger — it just calls the same
 * `checkAndRunAutomations` enqueue path. Useful for environments that prefer external cron
 * over the in-process scheduler.
 */

const AUTOMATION_RUN_PAYLOAD = z.object({
	automationId: z.string().uuid(),
})

let registered = false

export function registerAutomationJobHandlers(): void {
	if (registered) return

	registerJobHandler('automation_run', async ({ job }) => {
		const parsed = AUTOMATION_RUN_PAYLOAD.safeParse(job.payload)
		if (!parsed.success) {
			throw new Error(`automation_run payload missing/invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
		}
		const result = await runAutomationById(parsed.data.automationId)
		return {
			automationId: parsed.data.automationId,
			conversationId: result.conversationId,
			nextRunAt: result.nextRunAt,
		}
	})

	// Dispatch tick — every 60s, look for due automations and enqueue per-automation jobs.
	// Idempotent: dedupeKey on each enqueue collapses double-fires within the same tick window.
	// Note: `checkAndRunAutomations` itself doesn't need a dedupeKey because it's the
	// dispatcher (it INSPECTS due automations); only its enqueued automation_run jobs do.
	registerScheduledJob({
		name: 'automations.dispatch',
		intervalMs: 60_000,
		initialDelayMs: 15_000, // small jitter post-boot so it doesn't clash with workspace_gc
		enqueue: () => ({
			type: 'automations_dispatch',
			queue: 'maintenance',
			priority: 30, // above maintenance GC (10), below evaluation_run (75)
			dedupeKey: 'automations:dispatch',
			payload: {},
		}),
	})

	registerJobHandler('automations_dispatch', async () => {
		const result = await checkAndRunAutomations()
		return {
			evaluated: result.evaluated,
			enqueued: result.enqueued.filter((e) => !!e.jobId).length,
			errors: result.enqueued.filter((e) => !!e.error).length,
		}
	})

	registered = true
}
