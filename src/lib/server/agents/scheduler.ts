import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '$lib/server/db'
import { agentRuns, agents, agentTasks } from '$lib/server/db/schema'
import { executeAgentTask } from '$lib/server/agents/engine'

type SchedulerOptions = {
	maxConcurrent?: number
}

type SchedulerDrainOptions = SchedulerOptions & {
	maxTicks?: number
}

async function getOpenRunCount() {
	const openRuns = await db.select({ id: agentRuns.id }).from(agentRuns).where(isNull(agentRuns.endedAt))
	return openRuns.length
}

export async function runSchedulerTick(options: SchedulerOptions = {}) {
	const maxConcurrent = Math.max(1, Math.min(options.maxConcurrent ?? 2, 6))
	const openRunCount = await getOpenRunCount()
	const availableSlots = Math.max(0, maxConcurrent - openRunCount)

	if (availableSlots === 0) {
		return {
			processed: [],
			openRunCount,
			maxConcurrent,
		}
	}

	const queue = await db
		.select()
		.from(agentTasks)
		.where(inArray(agentTasks.status, ['pending', 'changes_requested']))
		.orderBy(desc(agentTasks.priority), asc(agentTasks.createdAt))
		.limit(availableSlots * 3)

	const processed: Array<{ taskId: string; success: boolean; error?: string }> = []

	for (const task of queue) {
		if (processed.length >= availableSlots) break

		const [agent] = await db.select().from(agents).where(eq(agents.id, task.agentId)).limit(1)
		if (!agent || agent.status === 'paused') continue

		const runningForAgent = await db
			.select({ id: agentRuns.id })
			.from(agentRuns)
			.where(and(eq(agentRuns.agentId, agent.id), isNull(agentRuns.endedAt)))
			.limit(1)
		if (runningForAgent.length > 0) continue

		try {
			await executeAgentTask(task.id)
			processed.push({ taskId: task.id, success: true })
		} catch (error) {
			processed.push({
				taskId: task.id,
				success: false,
				error: error instanceof Error ? error.message : 'Task execution failed',
			})
		}
	}

	return {
		processed,
		openRunCount,
		maxConcurrent,
	}
}

export async function runSchedulerUntilIdle(options: SchedulerDrainOptions = {}) {
	const maxTicks = Math.max(1, Math.min(options.maxTicks ?? 10, 50))
	const tickResults: Array<Awaited<ReturnType<typeof runSchedulerTick>>> = []

	for (let tick = 0; tick < maxTicks; tick++) {
		const result = await runSchedulerTick({ maxConcurrent: options.maxConcurrent })
		tickResults.push(result)

		const hasWork = result.processed.length > 0
		if (!hasWork) {
			break
		}
	}

	const snapshot = await getSchedulerSnapshot()
	return {
		ticks: tickResults.length,
		tickResults,
		snapshot,
	}
}

export async function getSchedulerSnapshot() {
	const tasks = await db.select({ status: agentTasks.status }).from(agentTasks)
	const openRuns = await db.select({ id: agentRuns.id }).from(agentRuns).where(isNull(agentRuns.endedAt))
	const agentsRows = await db.select({ id: agents.id, status: agents.status }).from(agents)

	const byStatus = {
		pending: 0,
		running: 0,
		review: 0,
		completed: 0,
		failed: 0,
	}

	for (const task of tasks) {
		if (task.status in byStatus) {
			const key = task.status as keyof typeof byStatus
			byStatus[key] += 1
		}
	}

	return {
		openRuns: openRuns.length,
		queue: byStatus,
		agents: {
			active: agentsRows.filter((row) => row.status === 'active').length,
			idle: agentsRows.filter((row) => row.status === 'idle').length,
			paused: agentsRows.filter((row) => row.status === 'paused').length,
		},
	}
}
