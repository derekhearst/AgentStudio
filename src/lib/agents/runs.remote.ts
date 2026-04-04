import { query } from '$app/server'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/server/db'
import { agentRuns, agents, agentTasks } from '$lib/server/db/schema'

const agentIdSchema = z.string().uuid()
const runIdSchema = z.string().uuid()

const listRunsSchema = z.object({
	agentId: z.string().uuid(),
	limit: z.number().int().min(1).max(100).optional(),
})

export const listAgentRuns = query(listRunsSchema, async ({ agentId, limit }) => {
	const rows = await db
		.select({
			id: agentRuns.id,
			taskId: agentRuns.taskId,
			startedAt: agentRuns.startedAt,
			endedAt: agentRuns.endedAt,
			cost: agentRuns.cost,
			tokenUsage: agentRuns.tokenUsage,
		})
		.from(agentRuns)
		.where(eq(agentRuns.agentId, agentId))
		.orderBy(desc(agentRuns.startedAt))
		.limit(limit ?? 50)

	// Fetch associated task titles
	const taskIds = rows.map((r) => r.taskId).filter((id): id is string => id !== null)
	const tasks =
		taskIds.length > 0
			? await db.select({ id: agentTasks.id, title: agentTasks.title, status: agentTasks.status }).from(agentTasks)
			: []
	const taskMap = new Map(tasks.map((t) => [t.id, t]))

	return rows.map((run) => ({
		...run,
		taskTitle: run.taskId ? (taskMap.get(run.taskId)?.title ?? null) : null,
		taskStatus: run.taskId ? (taskMap.get(run.taskId)?.status ?? null) : null,
	}))
})

export const getAgentRun = query(runIdSchema, async (runId) => {
	const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
	if (!run) return null

	const [agent] = await db
		.select({ id: agents.id, name: agents.name, role: agents.role, model: agents.model })
		.from(agents)
		.where(eq(agents.id, run.agentId))
		.limit(1)

	let task = null
	if (run.taskId) {
		const [taskRow] = await db.select().from(agentTasks).where(eq(agentTasks.id, run.taskId)).limit(1)
		task = taskRow ?? null
	}

	// Extract tool call details from task result if available
	const toolResults =
		task?.result && typeof task.result === 'object' && 'toolResults' in task.result
			? (task.result.toolResults as Array<{
					call: { name: string; arguments: Record<string, unknown> }
					result: { success: boolean; output?: string; error?: string; executionMs?: number }
				}>)
			: []

	return {
		run,
		agent: agent ?? null,
		task,
		toolResults,
	}
})
