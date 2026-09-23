import { json, type RequestHandler } from '@sveltejs/kit'
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns, runEvents } from '$lib/runs/runs.schema'
import { ACTIVE_CHAT_RUN_STATES } from '$lib/runs/runs.server'
import { createRunReplayStream } from '$lib/runs/run-replay-stream'
import { POLL_INTERVAL_MS } from '$lib/runtime/constants'
import { logger } from '$lib/observability/logger'

export const GET: RequestHandler = async ({ params, url, locals, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}
	if (!params.id) {
		return json({ error: 'conversationId is required' }, { status: 400 })
	}

	const sinceParam = url.searchParams.get('since') ?? '0'
	const since = Number.parseInt(sinceParam, 10)
	if (!Number.isFinite(since) || since < 0) {
		return json({ error: 'since must be a non-negative integer' }, { status: 400 })
	}

	// Find the most recent run for this conversation owned by this user.
	// Prefer an active one, otherwise fall back to the latest finished one
	// so a client can still backfill the events it missed before the run ended.
	const [run] = await db
		.select({ id: chatRuns.id, state: chatRuns.state, finishedAt: chatRuns.finishedAt })
		.from(chatRuns)
		.where(and(eq(chatRuns.conversationId, params.id), eq(chatRuns.userId, locals.user.id)))
		.orderBy(desc(chatRuns.updatedAt))
		.limit(1)

	if (!run) {
		return json({ error: 'No run found for this conversation' }, { status: 404 })
	}

	const runId = run.id
	const readable = createRunReplayStream({
		since,
		activeAtStart: (await isRunActive(runId)) !== null,
		pollIntervalMs: POLL_INTERVAL_MS,
		// The stream's own `cancel` covers a reader that goes away; this covers a request the
		// platform aborts before the body is ever read.
		signal: request.signal,
		source: {
			eventsAfter: (after) =>
				db
					.select({ seq: runEvents.seq, type: runEvents.type, payload: runEvents.payload })
					.from(runEvents)
					.where(and(eq(runEvents.runId, runId), gt(runEvents.seq, after)))
					.orderBy(asc(runEvents.seq)),
			isActive: async () => (await isRunActive(runId)) !== null,
		},
		onReplayError: (err) =>
			logger.error('[chat/stream/resume] replay failed', {
				runId,
				error: err instanceof Error ? err.message : String(err),
			}),
	})

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	})
}

async function isRunActive(runId: string): Promise<{ id: string } | null> {
	const [row] = await db
		.select({ id: chatRuns.id })
		.from(chatRuns)
		.where(
			and(eq(chatRuns.id, runId), inArray(chatRuns.state, ACTIVE_CHAT_RUN_STATES), isNull(chatRuns.finishedAt)),
		)
		.limit(1)
	return row ?? null
}
