import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { toolUsage } from '$lib/costs/usage.schema'
import { logToolUsage } from '$lib/costs/usage'
import { logger } from '$lib/observability/logger'
import type { VideoGenJob } from '$lib/llm/video-generation.server'

/**
 * Image and video generation spend, in the tool ledger where budgets and /costs can see it.
 *
 * Neither reached it reliably. `image_generate` kept its cost on the `images` row only —
 * budget limits and the cost summaries add up `llm_usage` and `tool_usage`, so two hundred
 * generated images could spend past a daily limit without it ever tripping. And
 * `video_generate` logged its cost only if the job finished inside the tool's poll window;
 * a long job came back "pending" and was billed minutes later with nothing recorded.
 */

// ─────────── Images ───────────

/** One `credit` row for a generated image's spend. Nothing is written for a free one. */
export async function logImageGenerationSpend(input: {
	cost: number
	model: string
	size: string
	userId: string | null
	runId: string | null
}): Promise<void> {
	if (!(input.cost > 0)) return
	await logToolUsage({
		toolName: 'image_generate',
		provider: 'openrouter',
		unitType: 'credit',
		units: 1,
		cost: input.cost,
		userId: input.userId,
		runId: input.runId,
		metadata: { model: input.model, size: input.size },
	})
}

// ─────────── Videos ───────────

/**
 * A video job's ledger row moves through `metadata.costStatus`:
 *
 *   pending → settled   the job completed; `cost` is what the provider reported
 *   pending → failed    the job failed; `cost` is whatever the provider still reported
 *   pending → abandoned nobody saw it finish within `VIDEO_COST_MAX_AGE_MS`
 *
 * The row is written when the job is submitted, so the ledger knows about a job before it
 * knows its price. Whichever of the tool itself, the `/api/video-jobs` poll route or the
 * reconcile job first sees the job finish settles it; the update is conditional on
 * `pending`, so the cost is recorded once however many of them see it.
 */
export type VideoCostStatus = 'pending' | 'settled' | 'failed' | 'abandoned'

/** How long a pending job is chased before it is given up on. */
export const VIDEO_COST_MAX_AGE_MS = 48 * 60 * 60 * 1000

export async function recordVideoJobSubmitted(input: {
	jobId: string
	model: string
	resolution?: string | null
	durationSeconds?: number | null
	userId: string | null
	runId: string | null
}): Promise<void> {
	await logToolUsage({
		toolName: 'video_generate',
		provider: 'openrouter',
		unitType: 'second',
		units: input.durationSeconds ?? 0,
		cost: 0,
		userId: input.userId,
		runId: input.runId,
		metadata: {
			model: input.model,
			resolution: input.resolution ?? null,
			jobId: input.jobId,
			costStatus: 'pending' satisfies VideoCostStatus,
		},
	})
}

export type SettleOutcome = 'settled' | 'failed' | 'pending' | 'already_settled'

/**
 * Record a video job's cost once it has finished. `pending` for a job still running;
 * `already_settled` when there is no pending row for it — someone else got there first, or
 * the job predates this ledger.
 */
export async function settleVideoJobCost(job: Pick<VideoGenJob, 'jobId' | 'status' | 'cost'>): Promise<SettleOutcome> {
	if (job.status !== 'completed' && job.status !== 'failed') return 'pending'
	const reported = typeof job.cost === 'number' && Number.isFinite(job.cost) && job.cost > 0 ? job.cost : null
	const status: VideoCostStatus = job.status === 'completed' ? 'settled' : 'failed'
	const patch: Record<string, unknown> = { costStatus: status, settledAt: new Date().toISOString() }
	// A completed job the provider reported no cost for is a gap, not a free video — the same
	// rule the model ledger follows.
	if (status === 'settled' && reported === null) patch.unpriced = 'no_cost_reported'

	const updated = await db
		.update(toolUsage)
		.set({
			cost: (reported ?? 0).toPrecision(15),
			metadata: sql`${toolUsage.metadata} || ${JSON.stringify(patch)}::jsonb`,
		})
		.where(
			and(
				eq(toolUsage.toolName, 'video_generate'),
				sql`${toolUsage.metadata}->>'jobId' = ${job.jobId}`,
				sql`${toolUsage.metadata}->>'costStatus' = 'pending'`,
			),
		)
		.returning({ id: toolUsage.id })
	return updated.length > 0 ? status : 'already_settled'
}

export type ReconcileSummary = { checked: number; settled: number; failed: number; abandoned: number; stillPending: number }

/**
 * Chase every pending video job: settle the ones that have finished, give up on the ones
 * older than `maxAgeMs`. Runs from the `video_cost_reconcile` job. `poll` is a parameter so
 * a spec can drive it without the provider.
 */
export async function reconcilePendingVideoJobs(
	options: {
		poll?: (jobId: string) => Promise<Pick<VideoGenJob, 'jobId' | 'status' | 'cost'>>
		now?: Date
		maxAgeMs?: number
		limit?: number
	} = {},
): Promise<ReconcileSummary> {
	const poll =
		options.poll ?? (async (jobId: string) => (await import('$lib/llm/video-generation.server')).pollVideoGenJob(jobId))
	const now = options.now ?? new Date()
	const maxAgeMs = options.maxAgeMs ?? VIDEO_COST_MAX_AGE_MS
	const summary: ReconcileSummary = { checked: 0, settled: 0, failed: 0, abandoned: 0, stillPending: 0 }

	const pending = await db
		.select({ id: toolUsage.id, createdAt: toolUsage.createdAt, jobId: sql<string>`${toolUsage.metadata}->>'jobId'` })
		.from(toolUsage)
		.where(and(eq(toolUsage.toolName, 'video_generate'), sql`${toolUsage.metadata}->>'costStatus' = 'pending'`))
		.orderBy(asc(toolUsage.createdAt))
		.limit(options.limit ?? 50)

	for (const row of pending) {
		summary.checked += 1
		if (now.getTime() - new Date(row.createdAt).getTime() > maxAgeMs) {
			await db
				.update(toolUsage)
				.set({ metadata: sql`${toolUsage.metadata} || ${JSON.stringify({ costStatus: 'abandoned', unpriced: 'job_never_finished' })}::jsonb` })
				.where(eq(toolUsage.id, row.id))
			logger.warn('[costs] gave up on a video job that never reported finishing; its cost is unrecorded', {
				jobId: row.jobId,
			})
			summary.abandoned += 1
			continue
		}
		try {
			const outcome = await settleVideoJobCost(await poll(row.jobId))
			if (outcome === 'settled') summary.settled += 1
			else if (outcome === 'failed') summary.failed += 1
			else if (outcome === 'pending') summary.stillPending += 1
		} catch (err) {
			// A poll error is not an answer; the next tick tries again.
			logger.warn('[costs] video job poll failed during reconcile', { jobId: row.jobId, err })
			summary.stillPending += 1
		}
	}
	return summary
}
