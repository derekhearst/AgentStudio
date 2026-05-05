import { command, query } from '$app/server'
import { and, desc, eq } from 'drizzle-orm'
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
import { executeTaskOnce } from './task-runner.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { getRepositoryById, listRepositories } from '$lib/source-control/source-control.server'

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

/**
 * Wave 2 #11 phase 4 follow-up — return the most recent parent task linked to any chat_run in
 * the given conversation, so the chat page can show a "→ Task: <title>" badge that deep-links
 * the user to the task they're materializing. Returns null when no run in this conversation
 * has a `task_id` set.
 */
const conversationIdSchema = z.string().uuid()
export const getActiveTaskForConversationQuery = query(conversationIdSchema, async (conversationId) => {
	const [row] = await db
		.select({
			id: tasks.id,
			title: tasks.title,
			status: tasks.status,
		})
		.from(chatRuns)
		.innerJoin(tasks, eq(tasks.id, chatRuns.taskId))
		.where(eq(chatRuns.conversationId, conversationId))
		.orderBy(desc(chatRuns.createdAt))
		.limit(1)
	return row ?? null
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

/**
 * Wave 2 #11 phase 5 — recursive subtree fetch for the DAG view.
 *
 * Walks the parent → child tree starting at `rootTaskId`, returning a flat list with each row
 * tagged by `depth` (0 = root, 1 = direct child, …). The UI renders a single component that
 * iterates the list and indents by depth — simpler than a nested-tree shape and lets the UI
 * stay flat for keyboard navigation.
 *
 * Bounded by `maxDepth` (default 5) to prevent runaway expansion if a future feature accidentally
 * creates cycles. Each level's children are sorted by priority then created_at.
 */
const subtreeSchema = z.object({
	rootTaskId: taskIdSchema,
	maxDepth: z.number().int().min(1).max(8).optional(),
})

export const getTaskSubtreeQuery = query(subtreeSchema, async ({ rootTaskId, maxDepth }) => {
	const root = await getTaskById(rootTaskId)
	if (!root) return null

	const limit = maxDepth ?? 5
	const flat: Array<TaskRow & { depth: number }> = [{ ...root, depth: 0 }]
	const queue: Array<{ id: string; depth: number }> = [{ id: rootTaskId, depth: 0 }]
	const seen = new Set<string>([rootTaskId])

	while (queue.length > 0) {
		const next = queue.shift()!
		if (next.depth >= limit) continue
		const children = await db
			.select()
			.from(tasks)
			.where(eq(tasks.parentTaskId, next.id))
		// Stable order: priority asc, then createdAt asc (matches the kanban + detail page).
		children.sort((a: TaskRow, b: TaskRow) => {
			if (a.priority !== b.priority) return a.priority - b.priority
			return a.createdAt.getTime() - b.createdAt.getTime()
		})
		for (const c of children) {
			if (seen.has(c.id)) continue // forward-compat: defend against cycles
			seen.add(c.id)
			flat.push({ ...c, depth: next.depth + 1 })
			queue.push({ id: c.id, depth: next.depth + 1 })
		}
	}

	return { root, flat }
})

const cancelTaskSchema = z.object({ taskId: taskIdSchema })

/**
 * Wave 2 #11 phase 5 — manual retry. Creates a NEW task_attempt + chat_run linked to the task
 * and runs it through the runtime. Allowed even from terminal states (failed / blocked /
 * completed / canceled) — the run-task-once flow handles the transition. Returns the new
 * attempt's outcome so the UI can show feedback.
 */
export const retryTaskCommand = command(cancelTaskSchema, async ({ taskId }) => {
	const result = await executeTaskOnce(taskId)
	return result
})

/**
 * Wave 5 #19 phase 2 finish — link/unlink a task to a connected repository.
 *
 * The task-runner reads `tasks.repository_id` to decide whether to provision a real
 * worktree at run start. This remote lets operators set the link from the task detail
 * page. Pass `repositoryId: null` to detach (the runner falls back to the agent's
 * legacy workspace).
 *
 * Authorization: the requesting user must own both the task (via createdBy) AND the
 * repository (via repositories.userId). Cross-user attachments would let an operator
 * read another user's working tree at run start; the FK doesn't catch that on its own.
 */
const setTaskRepositorySchema = z.object({
	taskId: taskIdSchema,
	repositoryId: z.string().uuid().nullable(),
})
export const setTaskRepositoryCommand = command(setTaskRepositorySchema, async ({ taskId, repositoryId }) => {
	const user = requireAuthenticatedRequestUser()
	const task = await getTaskById(taskId)
	if (!task) {
		throw new Error('Task not found')
	}
	if (task.createdBy && task.createdBy !== user.id) {
		throw new Error('Task does not belong to the requesting user')
	}
	if (repositoryId !== null) {
		const repo = await getRepositoryById(repositoryId)
		if (!repo) {
			throw new Error('Repository not found')
		}
		if (repo.userId !== user.id) {
			throw new Error('Repository does not belong to the requesting user')
		}
	}
	await db
		.update(tasks)
		.set({ repositoryId, updatedAt: new Date() })
		.where(eq(tasks.id, taskId))
	return getTaskById(taskId)
})

/**
 * Wave 5 #19 phase 2 finish — list connected repos for the task page picker. The picker
 * shows the active user's `repositories` rows (after they've sync'd via /source-control)
 * so operators can attach without leaving the task detail page.
 */
export const listConnectedRepositoriesQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	const repos = await listRepositories(user.id)
	return repos.map((r) => {
		const meta = (r.metadata ?? {}) as { htmlUrl?: string; private?: boolean }
		return {
			id: r.id,
			provider: r.provider,
			owner: r.owner,
			name: r.name,
			defaultBranch: r.defaultBranch,
			htmlUrl: meta.htmlUrl ?? null,
			private: !!meta.private,
		}
	})
})

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
