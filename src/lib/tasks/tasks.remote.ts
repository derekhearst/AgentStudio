import { command, query } from '$app/server'
import { and, asc, desc, eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { agentTasks, agents, taskComments, taskMessages } from '$lib/agents/agents.schema'

const execFileAsync = promisify(execFile)

async function runGit(args: string[], cwd = process.cwd()) {
	const { stdout } = await execFileAsync('git', args, { cwd })
	return stdout.trim()
}

async function getDiff(branch: string) {
	try {
		return await runGit(['diff', `main...${branch}`])
	} catch {
		return runGit(['diff', branch])
	}
}

async function getFileChanges(branch: string) {
	const raw = await runGit(['diff', '--name-status', `main...${branch}`])
	return raw
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [status, ...rest] = line.split(/\s+/)
			return { status, path: rest.join(' ') }
		})
}

async function mergeBranch(branch: string) {
	await runGit(['checkout', 'main'])
	await runGit(['merge', '--no-ff', branch, '-m', `Merge ${branch}`])
}

async function discardBranch(branch: string) {
	await runGit(['checkout', 'main'])
	await runGit(['branch', '-D', branch])
}

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

const reviewTaskIdSchema = z.string().uuid()

const requestRevisionSchema = z.object({
	taskId: z.string().uuid(),
	feedback: z.string().trim().min(1),
})

async function getTaskBranch(taskId: string) {
	const [task] = await db
		.select({ id: agentTasks.id, gitBranch: agentTasks.gitBranch })
		.from(agentTasks)
		.where(eq(agentTasks.id, taskId))
		.limit(1)

	if (!task) {
		throw new Error('Task not found')
	}

	return task.gitBranch ?? null
}

async function requireTaskBranch(taskId: string) {
	const branch = await getTaskBranch(taskId)
	if (!branch) {
		throw new Error('Task has no git branch')
	}
	return branch
}

export const getTaskDiff = query(reviewTaskIdSchema, async (taskId) => {
	const branch = await getTaskBranch(taskId)
	if (!branch) {
		return {
			branch: null,
			diff: '',
		}
	}
	return {
		branch,
		diff: await getDiff(branch),
	}
})

export const getChangedFiles = query(reviewTaskIdSchema, async (taskId) => {
	const branch = await getTaskBranch(taskId)
	if (!branch) {
		return {
			branch: null,
			files: [],
		}
	}
	return {
		branch,
		files: await getFileChanges(branch),
	}
})

export const approveChanges = command(reviewTaskIdSchema, async (taskId) => {
	const branch = await requireTaskBranch(taskId)
	await mergeBranch(branch)
	await db.update(agentTasks).set({ status: 'completed', completedAt: new Date() }).where(eq(agentTasks.id, taskId))

	return {
		success: true,
		branch,
	}
})

export const rejectChanges = command(reviewTaskIdSchema, async (taskId) => {
	const branch = await requireTaskBranch(taskId)
	await discardBranch(branch)
	await db.update(agentTasks).set({ status: 'failed', completedAt: new Date() }).where(eq(agentTasks.id, taskId))

	return {
		success: true,
		branch,
	}
})

export const requestRevision = command(requestRevisionSchema, async (input) => {
	await db
		.update(agentTasks)
		.set({
			status: 'pending',
			result: {
				revisionFeedback: input.feedback,
				revisionRequestedAt: new Date().toISOString(),
			},
		})
		.where(eq(agentTasks.id, input.taskId))

	return {
		success: true,
	}
})
