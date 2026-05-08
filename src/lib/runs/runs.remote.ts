import { command, query } from '$app/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { chatRuns, runEvents } from '$lib/runs/runs.schema'
import { conversations } from '$lib/sessions/sessions.schema'
import { agents } from '$lib/agents/agents.schema'
import { listEvaluationsForRun } from '$lib/evaluations/evaluations.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { dismissStuckRun } from '$lib/runs/runs.server'

/**
 * Single-run detail viewer.
 *
 * Returns the chat_run row, its linked conversation + agent (when present), AND the
 * full ordered event timeline. The `/runs/[id]` page renders this as a chronological trace
 * for debugging automation ticks and resumed chat streams.
 *
 * Per-token `delta` and `reasoning` events ARE persisted to run_events but they're noisy in
 * a debug view; the caller can opt to filter them by passing `includeNoisyEvents: false`.
 */

const runIdSchema = z.string().uuid()

const detailSchema = z.object({
	runId: runIdSchema,
	includeNoisyEvents: z.boolean().optional(),
}).default({ runId: '00000000-0000-0000-0000-000000000000' as never })

const NOISY_EVENT_TYPES = new Set(['delta', 'reasoning'])

export const getRunDetailQuery = query(detailSchema, async ({ runId, includeNoisyEvents }) => {
	if (!runId || runId === '00000000-0000-0000-0000-000000000000') return null

	const [run] = await db.select().from(chatRuns).where(eq(chatRuns.id, runId)).limit(1)
	if (!run) return null

	const [conversation] = await db
		.select({ id: conversations.id, title: conversations.title })
		.from(conversations)
		.where(eq(conversations.id, run.conversationId))
		.limit(1)

	let agent: { id: string; name: string; role: string } | null = null
	if (run.agentId) {
		const [a] = await db
			.select({ id: agents.id, name: agents.name, role: agents.role })
			.from(agents)
			.where(eq(agents.id, run.agentId))
			.limit(1)
		agent = a ?? null
	}

	const eventRows = await db
		.select({
			id: runEvents.id,
			seq: runEvents.seq,
			type: runEvents.type,
			payload: runEvents.payload,
			createdAt: runEvents.createdAt,
		})
		.from(runEvents)
		.where(eq(runEvents.runId, runId))
		.orderBy(asc(runEvents.seq))

	// `delta` and `reasoning` are persisted but noisy in a debug view — filter in JS rather
	// than via SQL so the toggle is cheap and we can still show the totals at the bottom.
	const events = includeNoisyEvents
		? eventRows
		: eventRows.filter((e) => !NOISY_EVENT_TYPES.has(e.type))

	// Wave 3 #14 — surface evaluator verdicts alongside the event timeline. Empty list when no
	// evaluation has fired (most runs today; the framework is opt-in via chat_runs.eval_required).
	const evaluations = await listEvaluationsForRun(runId)

	return {
		run,
		conversation: conversation ?? null,
		agent,
		events,
		evaluations,
		eventCount: eventRows.length,
		filteredOutCount: includeNoisyEvents ? 0 : eventRows.length - events.length,
	}
})

/**
 * Manual dismiss of a stuck run from the running-sessions dock.
 *
 * Counterpart to the time-based bulk reaper (`runs_reap.5min`). The reaper waits 1h before
 * cleaning up; this command lets the user clear an orphaned "Waiting for you" chip the
 * instant they see it. Auth-gated by `requireAuthenticatedRequestUser` and ownership-gated
 * inside `dismissStuckRun` (the WHERE clause requires `userId` match).
 */
export const dismissStuckRunCommand = command(z.object({ runId: runIdSchema }), async ({ runId }) => {
	const user = requireAuthenticatedRequestUser()
	return dismissStuckRun(user.id, runId)
})
