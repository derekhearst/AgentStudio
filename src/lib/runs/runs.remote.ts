import { query } from '$app/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { chatRuns, runEvents } from '$lib/runs/runs.schema'
import { conversations } from '$lib/sessions/sessions.schema'
import { agents } from '$lib/agents/agents.schema'
import { tasks } from '$lib/tasks/tasks.schema'

/**
 * Wave 2 #11 follow-up — single-run detail viewer.
 *
 * Returns the chat_run row, its linked conversation + agent + task (when present), AND the
 * full ordered event timeline. The `/runs/[id]` page renders this as a chronological trace
 * for debugging task runs, automation ticks, and resumed chat streams.
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

	let task: { id: string; title: string; status: string } | null = null
	if (run.taskId) {
		const [t] = await db
			.select({ id: tasks.id, title: tasks.title, status: tasks.status })
			.from(tasks)
			.where(eq(tasks.id, run.taskId))
			.limit(1)
		task = t ?? null
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

	return {
		run,
		conversation: conversation ?? null,
		agent,
		task,
		events,
		eventCount: eventRows.length,
		filteredOutCount: includeNoisyEvents ? 0 : eventRows.length - events.length,
	}
})
