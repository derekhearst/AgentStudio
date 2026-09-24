import { json, type RequestHandler } from '@sveltejs/kit'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { getRunHandle } from '$lib/engine/run-registry.server'
import { logger } from '$lib/observability/logger'

/**
 * Stop one background task (#35).
 *
 * The model can already background a command — `Bash` takes `run_in_background`, `TaskStop`
 * stops one, and the SDK reports every live task through `background_tasks_changed`. What was
 * missing is the other direction: a way for the user to stop one.
 * `Query.stopTask(id)` is a control request on the live session, so it needs the handle the
 * run registry publishes — which is exactly why the registry exists, since "stop" arrives
 * as a separate HTTP call from the run it is stopping.
 *
 * Ownership is checked against `chat_runs` before the registry is touched: the registry is
 * keyed by run id alone and knows nothing about who owns a run, so it must never be the
 * thing that decides whether a caller may stop something.
 *
 * `stopped: false` means "not stoppable from here", never "no such task" — a run in another
 * process, or one that ended between the click and the call, both land there. See the
 * registry's module note.
 */
export const POST: RequestHandler = async ({ request, params, locals }) => {
	try {
		if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 })
		if (!params.id) return json({ error: 'conversationId is required' }, { status: 400 })

		const body = (await request.json()) as { runId?: string; taskId?: string }
		if (!body.runId || !body.taskId) {
			return json({ error: 'runId and taskId are required' }, { status: 400 })
		}

		const [run] = await db
			.select({ id: chatRuns.id })
			.from(chatRuns)
			.where(
				and(
					eq(chatRuns.id, body.runId),
					eq(chatRuns.conversationId, params.id),
					eq(chatRuns.userId, locals.user.id),
					// A finished run's tasks are the CLI's to clean up, and its handle is gone.
					isNull(chatRuns.finishedAt),
				),
			)
			.limit(1)

		if (!run) return json({ stopped: false, reason: 'run_not_active' })

		const handle = getRunHandle(run.id)
		if (!handle) return json({ stopped: false, reason: 'not_reachable' })

		try {
			await handle.stopTask(body.taskId)
		} catch (error) {
			// Commonest cause is benign: the task finished between the click and the write.
			logger.warn('[chat/stop-task] stopTask failed', {
				runId: run.id,
				taskId: body.taskId,
				error: String(error),
			})
			return json({ stopped: false, reason: 'stop_failed' })
		}

		logger.info('[chat/stop-task] stopped a background task', { runId: run.id, taskId: body.taskId })
		return json({ stopped: true })
	} catch (error) {
		logger.error('[chat/stop-task] Failed to stop background task', {
			conversationId: params.id,
			userId: locals.user?.id ?? null,
			error: error instanceof Error ? error.message : String(error),
		})
		return json({ error: 'Failed to stop background task' }, { status: 500 })
	}
}
