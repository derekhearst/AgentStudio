import { and, desc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'

export const ACTIVE_CHAT_RUN_STATES = ['queued', 'running', 'waiting_tool_approval', 'waiting_user_input'] as const

export type ActiveChatRunState = (typeof ACTIVE_CHAT_RUN_STATES)[number]

/**
 * Default stale threshold for the stuck-run reaper. A run that has been in an active state
 * with no `updatedAt` movement for this long is presumed orphaned (the runtime that started
 * it is gone — process restart, crash, etc.). 1 hour is generous on top of the 5-minute
 * `QUESTION_TIMEOUT_MS` / `APPROVAL_TIMEOUT_MS` poll loops in the runtime, so a legitimate
 * pause-and-resume window won't trip the reaper.
 */
export const STUCK_RUN_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour

export async function listActiveChatRunsForUser(userId: string) {
	const rows = await db
		.select({
			id: chatRuns.id,
			conversationId: chatRuns.conversationId,
			agentId: chatRuns.agentId,
			state: chatRuns.state,
			label: chatRuns.label,
			lastDelta: chatRuns.lastDelta,
			error: chatRuns.error,
			startedAt: chatRuns.startedAt,
			lastHeartbeatAt: chatRuns.lastHeartbeatAt,
			updatedAt: chatRuns.updatedAt,
		})
		.from(chatRuns)
		.where(
			and(eq(chatRuns.userId, userId), isNull(chatRuns.finishedAt), inArray(chatRuns.state, ACTIVE_CHAT_RUN_STATES)),
		)
		.orderBy(desc(chatRuns.updatedAt))

	const byConversation = new Map<string, (typeof rows)[number]>()
	for (const row of rows) {
		if (!byConversation.has(row.conversationId)) {
			byConversation.set(row.conversationId, row)
		}
	}
	return [...byConversation.values()]
}

export async function listActiveAgentRunsForUser(userId: string) {
	return db
		.select({
			id: chatRuns.id,
			conversationId: chatRuns.conversationId,
			agentId: chatRuns.agentId,
			state: chatRuns.state,
			label: chatRuns.label,
			lastDelta: chatRuns.lastDelta,
			startedAt: chatRuns.startedAt,
			lastHeartbeatAt: chatRuns.lastHeartbeatAt,
			updatedAt: chatRuns.updatedAt,
		})
		.from(chatRuns)
		.where(
			and(
				eq(chatRuns.userId, userId),
				inArray(chatRuns.state, ACTIVE_CHAT_RUN_STATES),
				isNull(chatRuns.finishedAt),
				isNotNull(chatRuns.agentId),
			),
		)
		.orderBy(desc(chatRuns.updatedAt))
}

/**
 * Reap chat_runs that are stuck in active states with stale `updatedAt`.
 *
 * Why this exists: when a runtime process restarts or crashes mid-run, its in-memory poll
 * loops (awaitQuestionAnswers, awaitApprovalDecisions, the streaming loop) die. The DB row
 * stays in `waiting_user_input` / `waiting_tool_approval` / `running` indefinitely, and the
 * RunningSessionsDock + the home page recent-chats list both display the orphan as "Waiting
 * for you" forever. There's no way for the user to dismiss them from the UI today.
 *
 * What it does: find every chat_run with `finishedAt IS NULL`, an active state, and an
 * `updatedAt` older than `thresholdMs`. Mark each as `state='canceled'`, `finishedAt=now`,
 * `error=<reason>`, and clear `pendingApprovals` + `pendingQuestions` so the conversation
 * can be re-used cleanly. Returns the count for telemetry.
 *
 * Best-effort: a thrown error is caught at the scheduler boundary so a flaky DB doesn't
 * stop other maintenance ticks. Idempotent across ticks because the WHERE clause requires
 * `finishedAt IS NULL`.
 */
export async function reapStuckRuns(opts?: {
	now?: Date
	thresholdMs?: number
}): Promise<{ reapedCount: number; reapedIds: string[] }> {
	const now = opts?.now ?? new Date()
	const thresholdMs = opts?.thresholdMs ?? STUCK_RUN_THRESHOLD_MS
	const cutoff = new Date(now.getTime() - thresholdMs)

	const reaped = await db
		.update(chatRuns)
		.set({
			state: 'canceled',
			finishedAt: now,
			updatedAt: now,
			error: `Reaped: stuck in active state for >${Math.round(thresholdMs / 60_000)} minutes (process restart or orphaned runtime)`,
			pendingApprovals: [],
			pendingQuestions: [],
		})
		.where(
			and(
				isNull(chatRuns.finishedAt),
				inArray(chatRuns.state, ACTIVE_CHAT_RUN_STATES),
				lt(chatRuns.updatedAt, cutoff),
			),
		)
		.returning({ id: chatRuns.id })

	return { reapedCount: reaped.length, reapedIds: reaped.map((r) => r.id) }
}

/**
 * Manual dismiss of a single stuck run by its owner.
 *
 * Counterpart to the time-based bulk reaper. Lets the user clear a "Waiting for you" chip
 * from the RunningSessionsDock immediately instead of waiting up to ~6 minutes for the next
 * `runs_reap.5min` tick. Ownership is enforced — the row must belong to the calling user
 * AND still be in an active state with `finishedAt IS NULL`. Idempotent: a second call on
 * the same id finds nothing to update and returns `success: false`.
 */
export async function dismissStuckRun(
	userId: string,
	runId: string,
): Promise<{ success: boolean }> {
	const now = new Date()
	const updated = await db
		.update(chatRuns)
		.set({
			state: 'canceled',
			finishedAt: now,
			updatedAt: now,
			error: 'Dismissed by user from the running-sessions dock',
			pendingApprovals: [],
			pendingQuestions: [],
		})
		.where(
			and(
				eq(chatRuns.id, runId),
				eq(chatRuns.userId, userId),
				isNull(chatRuns.finishedAt),
				inArray(chatRuns.state, ACTIVE_CHAT_RUN_STATES),
			),
		)
		.returning({ id: chatRuns.id })

	return { success: updated.length > 0 }
}
