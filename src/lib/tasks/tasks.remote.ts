import { command, query } from '$app/server'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/server/db'
import { agentTasks, agents, taskComments, taskMessages } from '$lib/server/db/schema'

const taskIdSchema = z.string().uuid()

const setTaskStatusSchema = z.object({
	taskId: z.string().uuid(),
	status: z.enum(['pending', 'running', 'review', 'completed', 'failed', 'changes_requested']),
})

const setTaskPrioritySchema = z.object({
	taskId: z.string().uuid(),
	priority: z.number().int().min(0).max(5),
})

const reassignTaskSchema = z.object({
	taskId: z.string().uuid(),
	agentId: z.string().uuid(),
})

const listTasksSchema = z.object({
	status: z.enum(['pending', 'running', 'review', 'completed', 'failed', 'changes_requested']).optional(),
	agentId: z.string().uuid().optional(),
	limit: z.number().int().min(1).max(500).optional(),
})

export const listTasks = query(listTasksSchema, async ({ status, agentId, limit }) => {
	const rows = await db
		.select()
		.from(agentTasks)
		.where(
			and(status ? eq(agentTasks.status, status) : undefined, agentId ? eq(agentTasks.agentId, agentId) : undefined),
		)
		.orderBy(desc(agentTasks.priority), asc(agentTasks.createdAt))
		.limit(limit ?? 200)

	const agentRows = await db.select({ id: agents.id, name: agents.name }).from(agents)
	const byId = new Map(agentRows.map((row) => [row.id, row]))

	return rows.map((task) => ({
		...task,
		agentName: byId.get(task.agentId)?.name ?? 'Unknown agent',
	}))
})

export const getTask = query(taskIdSchema, async (taskId) => {
	const [task] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1)
	if (!task) return null

	const [agent] = await db
		.select({ id: agents.id, name: agents.name, status: agents.status })
		.from(agents)
		.where(eq(agents.id, task.agentId))
		.limit(1)
	return {
		task,
		agent: agent ?? null,
	}
})

export const setTaskStatus = command(setTaskStatusSchema, async ({ taskId, status }) => {
	const [updated] = await db
		.update(agentTasks)
		.set({
			status,
			completedAt: status === 'completed' || status === 'failed' ? new Date() : null,
		})
		.where(eq(agentTasks.id, taskId))
		.returning()
	return updated
})

export const setTaskPriority = command(setTaskPrioritySchema, async ({ taskId, priority }) => {
	const [updated] = await db.update(agentTasks).set({ priority }).where(eq(agentTasks.id, taskId)).returning()
	return updated
})

export const reassignTask = command(reassignTaskSchema, async ({ taskId, agentId }) => {
	const [updated] = await db
		.update(agentTasks)
		.set({
			agentId,
			status: 'pending',
		})
		.where(eq(agentTasks.id, taskId))
		.returning()
	return updated
})

// --- Phase B1: Changes Requested ---
const requestChangesSchema = z.object({
	taskId: z.string().uuid(),
	comment: z.string().trim().min(1).max(4000),
})

export const requestChanges = command(requestChangesSchema, async ({ taskId, comment }) => {
	await db.insert(taskComments).values({
		taskId,
		role: 'user',
		content: comment,
	})

	const [updated] = await db
		.update(agentTasks)
		.set({ status: 'changes_requested', completedAt: null })
		.where(eq(agentTasks.id, taskId))
		.returning()

	return updated
})

export const getTaskComments = query(taskIdSchema, async (taskId) => {
	return db.select().from(taskComments).where(eq(taskComments.taskId, taskId)).orderBy(asc(taskComments.createdAt))
})

// --- Phase B2: Task-Level Chat Threads ---
const addTaskMessageSchema = z.object({
	taskId: z.string().uuid(),
	content: z.string().trim().min(1).max(8000),
})

export const getTaskMessages = query(taskIdSchema, async (taskId) => {
	return db.select().from(taskMessages).where(eq(taskMessages.taskId, taskId)).orderBy(asc(taskMessages.createdAt))
})

export const addTaskMessage = command(addTaskMessageSchema, async ({ taskId, content }) => {
	const [msg] = await db.insert(taskMessages).values({ taskId, role: 'user', content }).returning()
	return msg
})
