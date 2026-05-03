import { command, query } from '$app/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { tasks } from './tasks.schema'
import {
	getTaskById,
	listAttemptsForTask,
	listTasks,
	setTaskStatus,
	type TaskRow,
} from './tasks.server'

const taskIdSchema = z.string().uuid()

const listTasksSchema = z.object({
	includeTerminal: z.boolean().optional(),
	parentTaskId: z.string().uuid().nullable().optional(),
	limit: z.number().int().min(1).max(500).optional(),
}).default({})

const setStatusSchema = z.object({
	taskId: taskIdSchema,
	status: z.enum([
		'pending',
		'planning',
		'awaiting_approval',
		'running',
		'blocked',
		'completed',
		'failed',
		'canceled',
	]),
})

export const listTasksQuery = query(listTasksSchema, async (input) => {
	const rows = await listTasks({
		includeTerminal: input.includeTerminal ?? true,
		parentTaskId: input.parentTaskId ?? undefined,
		limit: input.limit,
	})
	// Annotate with child counts so the kanban can render "3 steps" without a second roundtrip.
	if (rows.length === 0) return rows.map((r) => ({ ...r, childCount: 0 }))
	const parentIds = rows.map((r) => r.id)
	const childCounts = new Map<string, number>()
	const children = await db
		.select({ parentTaskId: tasks.parentTaskId })
		.from(tasks)
	for (const c of children) {
		if (c.parentTaskId && parentIds.includes(c.parentTaskId)) {
			childCounts.set(c.parentTaskId, (childCounts.get(c.parentTaskId) ?? 0) + 1)
		}
	}
	return rows.map((r) => ({ ...r, childCount: childCounts.get(r.id) ?? 0 }))
})

export const getTaskByIdQuery = query(taskIdSchema, async (taskId) => {
	const task = await getTaskById(taskId)
	if (!task) return null
	const children = await db
		.select()
		.from(tasks)
		.where(eq(tasks.parentTaskId, taskId))
	const attempts = await listAttemptsForTask(taskId)
	const linkedRuns = await db
		.select({
			id: chatRuns.id,
			conversationId: chatRuns.conversationId,
			state: chatRuns.state,
			label: chatRuns.label,
			startedAt: chatRuns.startedAt,
			finishedAt: chatRuns.finishedAt,
		})
		.from(chatRuns)
		.where(eq(chatRuns.taskId, taskId))
	return {
		task,
		children: children.sort((a: TaskRow, b: TaskRow) => a.priority - b.priority),
		attempts,
		linkedRuns,
	}
})

export const setTaskStatusCommand = command(setStatusSchema, async ({ taskId, status }) => {
	return setTaskStatus(taskId, status)
})

const cancelTaskSchema = z.object({ taskId: taskIdSchema })

/**
 * Cancel a task and any non-terminal direct children (one level — matches the propose_plan tree
 * shape today). Preserves completed/failed/already-canceled descendants for forensic visibility.
 */
export const cancelTaskCommand = command(cancelTaskSchema, async ({ taskId }) => {
	const target = await getTaskById(taskId)
	if (!target) return null
	if (['completed', 'failed', 'canceled'].includes(target.status)) return target
	await db.update(tasks).set({ status: 'canceled', updatedAt: new Date() }).where(eq(tasks.id, taskId))
	await db
		.update(tasks)
		.set({ status: 'canceled', updatedAt: new Date() })
		.where(
			and(
				eq(tasks.parentTaskId, taskId),
				eq(tasks.status, 'pending'),
			),
		)
	return getTaskById(taskId)
})
