import { command, query } from '$app/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/server/db'
import { agentTasks } from '$lib/server/db/schema'
import { discardBranch, getDiff, getFileChanges, mergeBranch } from '$lib/server/tools/git'

const taskIdSchema = z.string().uuid()

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

export const getTaskDiff = query(taskIdSchema, async (taskId) => {
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

export const getChangedFiles = query(taskIdSchema, async (taskId) => {
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

export const approveChanges = command(taskIdSchema, async (taskId) => {
	const branch = await requireTaskBranch(taskId)
	await mergeBranch(branch)
	await db.update(agentTasks).set({ status: 'completed', completedAt: new Date() }).where(eq(agentTasks.id, taskId))

	return {
		success: true,
		branch,
	}
})

export const rejectChanges = command(taskIdSchema, async (taskId) => {
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
