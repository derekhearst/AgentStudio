import { json, type RequestHandler } from '@sveltejs/kit'
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns, runEvents } from '$lib/runs/runs.schema'
import { ACTIVE_CHAT_RUN_STATES } from '$lib/runs/runs.server'
import { encodeSseFrame } from '$lib/runtime/sse-codec'
import { POLL_INTERVAL_MS } from '$lib/runtime/constants'
import { logger } from '$lib/observability/logger'

export const GET: RequestHandler = async ({ params, url, locals }) => {
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
	const isActive = (await isRunActive(runId)) !== null

	const readable = new ReadableStream<Uint8Array>({
		async start(controller) {
			let clientConnected = true
			const enqueue = (chunk: Uint8Array) => {
				if (!clientConnected) return
				try {
					controller.enqueue(chunk)
				} catch {
					clientConnected = false
				}
			}

			let lastSeq = since

			// Replay missed events
			try {
				const replay = await db
					.select()
					.from(runEvents)
					.where(and(eq(runEvents.runId, runId), gt(runEvents.seq, lastSeq)))
					.orderBy(asc(runEvents.seq))
				for (const ev of replay) {
					enqueue(encodeSseFrame(ev.type, ev.payload, ev.seq))
					lastSeq = ev.seq
				}
			} catch (err) {
				logger.error('[chat/stream/resume] replay failed', {
					runId,
					error: err instanceof Error ? err.message : String(err),
				})
				enqueue(encodeSseFrame('done', { error: 'Resume replay failed' }))
				if (clientConnected) controller.close()
				return
			}

			// If the run was already terminal when we started, send a synthetic done and close.
			if (!isActive) {
				enqueue(encodeSseFrame('done', { resumed: true, terminal: true }))
				if (clientConnected) controller.close()
				return
			}

			// Tail new events until terminal state.
			while (clientConnected) {
				const tail = await db
					.select()
					.from(runEvents)
					.where(and(eq(runEvents.runId, runId), gt(runEvents.seq, lastSeq)))
					.orderBy(asc(runEvents.seq))
				for (const ev of tail) {
					enqueue(encodeSseFrame(ev.type, ev.payload, ev.seq))
					lastSeq = ev.seq
				}

				if ((await isRunActive(runId)) === null) {
					// Drain any final events that landed between our last poll and the state flip.
					const final = await db
						.select()
						.from(runEvents)
						.where(and(eq(runEvents.runId, runId), gt(runEvents.seq, lastSeq)))
						.orderBy(asc(runEvents.seq))
					for (const ev of final) {
						enqueue(encodeSseFrame(ev.type, ev.payload, ev.seq))
						lastSeq = ev.seq
					}
					break
				}

				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
			}

			if (clientConnected) controller.close()
		},
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
