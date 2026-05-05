import { z } from 'zod'
import { registerJobHandler } from '$lib/jobs/worker.server'
import { registerScheduledJob } from '$lib/jobs/scheduler.server'
import { runWorkspaceGc } from './gc.server'

/**
 * Wave 4 #17 phase 4 + 5 — `workspace_gc` job handler + daily schedule.
 *
 * Migrates the cron-tick driven GC into a queued job that the scheduler enqueues every 24h.
 * Same pattern as the memory_mine + evaluation_run migrations: the work survives restart,
 * dedupes via `gc:daily` (so multiple ticks within the dedupe window collapse to one), and
 * failures are visible in `/settings/jobs` instead of silently dropped from the cron tick.
 *
 * The handler returns the GC summary (counts of removed run/worktree dirs + bytes freed)
 * into `jobs.result` so admins can scroll back through GC history without grepping logs.
 */

const WORKSPACE_GC_PAYLOAD = z
	.object({
		ttlDays: z.number().int().min(1).max(365).optional(),
		dryRun: z.boolean().optional(),
	})
	.default({})

const DEFAULT_GC_INTERVAL_MS = 24 * 60 * 60 * 1000 // daily

let registered = false

export function registerWorkspaceJobHandlers(): void {
	if (registered) return

	registerJobHandler('workspace_gc', async ({ job }) => {
		const parsed = WORKSPACE_GC_PAYLOAD.safeParse(job.payload)
		if (!parsed.success) {
			throw new Error(`workspace_gc payload invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
		}
		const sandboxRoot = process.env.SANDBOX_WORKSPACE || '/workspace'
		const summary = await runWorkspaceGc({
			sandboxRoot,
			ttlDays: parsed.data.ttlDays,
			dryRun: parsed.data.dryRun,
		})
		return {
			sandboxRoot,
			scanned: summary.scanned,
			deleted: summary.deleted,
			skipped: summary.skipped,
			errors: summary.errors,
			dryRun: summary.dryRun,
		}
	})

	// Schedule a daily run via the in-process scheduler. Idempotent — `gc:daily` dedupeKey
	// means multiple boots within a day collapse to one pending job until the worker claims it.
	registerScheduledJob({
		name: 'workspace_gc.daily',
		intervalMs: DEFAULT_GC_INTERVAL_MS,
		// Fire once at boot too (after the small startup delay) so a fresh deploy picks up GC
		// without waiting 24h for the first interval to elapse.
		initialDelayMs: 30_000,
		enqueue: () => ({
			type: 'workspace_gc',
			queue: 'maintenance',
			priority: 10, // lowest tier — never preempt user-facing work
			dedupeKey: 'gc:daily',
			payload: {},
		}),
	})

	registered = true
}
