import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { taskAttempts, tasks } from './tasks.schema'

export type TaskStatus = (typeof tasks.$inferSelect)['status']
export type TaskAttemptStatus = (typeof taskAttempts.$inferSelect)['status']
export type TaskRow = typeof tasks.$inferSelect
export type TaskAttemptRow = typeof taskAttempts.$inferSelect

const TERMINAL_TASK_STATES: TaskStatus[] = ['completed', 'failed', 'canceled']

export type CreateTaskInput = {
	title: string
	spec: string
	status?: TaskStatus
	parentTaskId?: string | null
	ownerAgentId?: string | null
	rootConversationId?: string | null
	priority?: number
	budgetUsd?: number | string | null
	metadata?: Record<string, unknown>
	createdBy?: string | null
}

/**
 * Insert a new task. Defaults to `pending` so the orchestrator can create a fully-described task
 * before the user approves the plan that wraps it.
 */
export async function createTask(input: CreateTaskInput): Promise<TaskRow> {
	const [row] = await db
		.insert(tasks)
		.values({
			title: input.title,
			spec: input.spec,
			status: input.status ?? 'pending',
			parentTaskId: input.parentTaskId ?? null,
			ownerAgentId: input.ownerAgentId ?? null,
			rootConversationId: input.rootConversationId ?? null,
			priority: input.priority ?? 0,
			budgetUsd: input.budgetUsd != null ? String(input.budgetUsd) : null,
			metadata: input.metadata ?? {},
			createdBy: input.createdBy ?? null,
		})
		.returning()
	return row
}

export async function getTaskById(taskId: string): Promise<TaskRow | null> {
	const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
	return row ?? null
}

/**
 * List tasks for a user (or globally if `userId` is null/undefined). Excludes terminal tasks by
 * default — callers can opt back in via `includeTerminal: true`.
 */
export async function listTasks(opts: {
	userId?: string | null
	includeTerminal?: boolean
	parentTaskId?: string | null
	limit?: number
}): Promise<TaskRow[]> {
	const filters = []
	if (opts.userId) filters.push(eq(tasks.createdBy, opts.userId))
	if (opts.parentTaskId === null) filters.push(isNull(tasks.parentTaskId))
	else if (opts.parentTaskId) filters.push(eq(tasks.parentTaskId, opts.parentTaskId))
	if (!opts.includeTerminal) {
		filters.push(sql`${tasks.status} not in ('completed', 'failed', 'canceled')`)
	}
	return db
		.select()
		.from(tasks)
		.where(filters.length > 0 ? and(...filters) : undefined)
		.orderBy(asc(tasks.priority), asc(tasks.createdAt))
		.limit(opts.limit ?? 200)
}

/**
 * Transition a task to a new status. Returns null if the task doesn't exist. No-op if the task
 * is already in the target state. Terminal-state guard prevents accidental resurrection — call
 * `forceTransition` if that's actually what the caller wants.
 */
export async function setTaskStatus(taskId: string, nextStatus: TaskStatus): Promise<TaskRow | null> {
	const current = await getTaskById(taskId)
	if (!current) return null
	if (current.status === nextStatus) return current
	if (TERMINAL_TASK_STATES.includes(current.status)) {
		throw new Error(`Cannot transition terminal task ${taskId} (status=${current.status}) → ${nextStatus}`)
	}
	const [row] = await db
		.update(tasks)
		.set({ status: nextStatus, updatedAt: new Date() })
		.where(eq(tasks.id, taskId))
		.returning()
	return row ?? null
}

/**
 * Record a new attempt on a task. attemptNumber is auto-incremented by counting existing
 * attempts for the task — callers don't have to track it.
 */
export async function recordAttempt(input: {
	taskId: string
	runId?: string | null
	status?: TaskAttemptStatus
	error?: string | null
	costUsd?: number | string | null
	startedAt?: Date | null
	finishedAt?: Date | null
}): Promise<TaskAttemptRow> {
	const [{ count }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(taskAttempts)
		.where(eq(taskAttempts.taskId, input.taskId))
	const [row] = await db
		.insert(taskAttempts)
		.values({
			taskId: input.taskId,
			runId: input.runId ?? null,
			attemptNumber: (count ?? 0) + 1,
			status: input.status ?? 'queued',
			error: input.error ?? null,
			costUsd: input.costUsd != null ? String(input.costUsd) : null,
			startedAt: input.startedAt ?? null,
			finishedAt: input.finishedAt ?? null,
		})
		.returning()
	return row
}

export async function listAttemptsForTask(taskId: string): Promise<TaskAttemptRow[]> {
	return db
		.select()
		.from(taskAttempts)
		.where(eq(taskAttempts.taskId, taskId))
		.orderBy(asc(taskAttempts.attemptNumber))
}

/**
 * Update an attempt — typically when the corresponding chat_run terminates and the runner needs
 * to record the final status / cost / error. Returns null if not found.
 */
export async function updateAttempt(
	attemptId: string,
	patch: {
		status?: TaskAttemptStatus
		error?: string | null
		costUsd?: number | string | null
		startedAt?: Date | null
		finishedAt?: Date | null
		runId?: string | null
	},
): Promise<TaskAttemptRow | null> {
	const updates: Partial<typeof taskAttempts.$inferInsert> = {}
	if (patch.status !== undefined) updates.status = patch.status
	if (patch.error !== undefined) updates.error = patch.error
	if (patch.costUsd !== undefined) {
		updates.costUsd = patch.costUsd != null ? String(patch.costUsd) : null
	}
	if (patch.startedAt !== undefined) updates.startedAt = patch.startedAt
	if (patch.finishedAt !== undefined) updates.finishedAt = patch.finishedAt
	if (patch.runId !== undefined) updates.runId = patch.runId
	if (Object.keys(updates).length === 0) return null
	const [row] = await db.update(taskAttempts).set(updates).where(eq(taskAttempts.id, attemptId)).returning()
	return row ?? null
}
