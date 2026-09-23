import { json, type RequestHandler } from '@sveltejs/kit'
import { stopChatRun } from '$lib/runs/runs.server'
import { logger } from '$lib/observability/logger'

/**
 * Stop the conversation's live run — the chat's Stop button.
 *
 * Its own request because a dropped stream no longer stops anything: a run outlives a reload
 * or a network blip and is picked up again through `stream/resume`. See `stopChatRun`.
 *
 * `stopped: false` is an answer, not an error: `run_not_active` when the turn already ended,
 * `not_reachable` when no session in this process holds it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 })
	if (!params.id || !UUID.test(params.id)) return json({ error: 'conversationId is required' }, { status: 400 })

	const body = (await request.json().catch(() => ({}))) as { runId?: unknown }
	const runId = typeof body.runId === 'string' && body.runId.length > 0 ? body.runId : null
	// Checked here so a malformed id is a 400 rather than a uuid cast error from Postgres.
	if (runId && !UUID.test(runId)) return json({ error: 'runId must be a uuid' }, { status: 400 })

	try {
		return json(await stopChatRun({ userId: locals.user.id, conversationId: params.id, runId }))
	} catch (error) {
		logger.error('[chat/stop] failed to stop the run', {
			conversationId: params.id,
			runId,
			error: error instanceof Error ? error.message : String(error),
		})
		return json({ error: 'Failed to stop the run' }, { status: 500 })
	}
}
