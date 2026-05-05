import { z } from 'zod'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { tasks } from './tasks.schema'
import { enqueueJob } from '$lib/jobs/jobs.server'
import { registerJobHandler } from '$lib/jobs/worker.server'
import { registerScheduledJob } from '$lib/jobs/scheduler.server'
import { executeTaskOnce } from './task-runner.server'

/**
 * Wave 2 #11 phase 3 finish — `task_run` job handler + `tasks.dispatch` scheduled tick.
 *
 * Picks up `pending` tasks that have an `ownerAgentId` set + are top-level (no
 * `parentTaskId`) and enqueues a `task_run` job for each. The runner calls
 * `executeTaskOnce(taskId)` which transitions the task → running → completed/failed,
 * opens a chat_runs row, and records a task_attempt.
 *
 * Why top-level only: child tasks of `propose_plan` parents are executed inline by the
 * orchestrator chat that approved the plan. A background runner that competed with that
 * flow would create double-execution. This dispatcher is for tasks created OUTSIDE the
 * propose_plan flow — UI-created tasks, API-created tasks, future scheduled tasks.
 *
 * Idempotency: dedupeKey `task:<taskId>` collapses retries within the same tick window;
 * the runner itself flips the task out of `pending` before doing work, so the next tick
 * won't see it again.
 */

const TASK_RUN_PAYLOAD = z.object({
	taskId: z.string().uuid(),
	maxRetriesOnRevision: z.number().int().min(0).max(5).optional(),
})

const TASK_DISPATCH_BATCH_LIMIT = 25

export type DispatchTasksResult = {
	scanned: number
	enqueued: Array<{ taskId: string; jobId?: string; error?: string }>
}

/**
 * Find all `pending` top-level tasks with an `ownerAgentId` and enqueue a `task_run` job
 * for each. Idempotent: re-firing with the same task in the queue is a no-op via dedupeKey.
 */
export async function dispatchPendingTasks(): Promise<DispatchTasksResult> {
	const due = await db
		.select({ id: tasks.id, priority: tasks.priority, createdBy: tasks.createdBy })
		.from(tasks)
		.where(
			and(
				eq(tasks.status, 'pending'),
				isNotNull(tasks.ownerAgentId),
				isNull(tasks.parentTaskId),
			),
		)
		.limit(TASK_DISPATCH_BATCH_LIMIT)

	const enqueued: DispatchTasksResult['enqueued'] = []
	for (const t of due) {
		try {
			const job = await enqueueJob({
				type: 'task_run',
				queue: 'default',
				// Higher than memory_mine (50) but below user-initiated (100+) — task work is
				// nearline (operators expect it to complete soon) but not directly user-facing.
				priority: 60 + Math.max(0, Math.min(t.priority ?? 0, 30)),
				userId: t.createdBy ?? null,
				dedupeKey: `task:${t.id}`,
				payload: { taskId: t.id },
			})
			enqueued.push({ taskId: t.id, jobId: job.id })
		} catch (err) {
			enqueued.push({ taskId: t.id, error: err instanceof Error ? err.message : String(err) })
		}
	}
	return { scanned: due.length, enqueued }
}

let registered = false

export function registerTaskJobHandlers(): void {
	if (registered) return

	registerJobHandler('task_run', async ({ job }) => {
		const parsed = TASK_RUN_PAYLOAD.safeParse(job.payload)
		if (!parsed.success) {
			throw new Error(`task_run payload missing/invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
		}
		const result = await executeTaskOnce(parsed.data.taskId, {
			maxRetriesOnRevision: parsed.data.maxRetriesOnRevision,
		})
		return {
			taskId: result.taskId,
			runId: result.runId,
			completed: result.completed,
			error: result.error,
			evaluationVerdict: result.evaluationVerdict ?? null,
		}
	})

	registerJobHandler('tasks_dispatch', async () => {
		const result = await dispatchPendingTasks()
		return {
			scanned: result.scanned,
			enqueued: result.enqueued.filter((e) => !!e.jobId).length,
			errors: result.enqueued.filter((e) => !!e.error).length,
		}
	})

	// Dispatch tick — every 90s, scan for pending tasks. Slightly slower cadence than
	// automations.dispatch (60s) since tasks are typically less time-sensitive.
	registerScheduledJob({
		name: 'tasks.dispatch',
		intervalMs: 90_000,
		initialDelayMs: 30_000,
		enqueue: () => ({
			type: 'tasks_dispatch',
			queue: 'maintenance',
			priority: 25, // above maintenance GC (10), below automations.dispatch (30)
			dedupeKey: 'tasks:dispatch',
			payload: {},
		}),
	})

	registered = true
}
