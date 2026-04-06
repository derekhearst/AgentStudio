import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { agentRuns, agents, agentTasks } from '$lib/agents/agents.schema'
import { chat } from '$lib/llm/openrouter'
import { executeTool, toolSchemas, type ToolCall, type ToolName } from '$lib/llm/tools'
import { logLlmUsage } from '$lib/llm/usage'
import { emitActivity } from '$lib/activity/emit'
import { listSkillSummaries } from '$lib/skills/store'

type CreateAgentTaskInput = {
	agentId: string
	title: string
	description: string
	priority?: number
}

const allToolNames = Object.keys(toolSchemas) as [string, ...string[]]

const toolLoopSchema = z.object({
	analysis: z.string().optional(),
	toolCalls: z
		.array(
			z.object({
				name: z.enum(allToolNames),
				arguments: z.record(z.string(), z.unknown()).default({}),
			}),
		)
		.max(3)
		.optional(),
	finalSummary: z.string().optional(),
})

type PlannedToolLoop = z.infer<typeof toolLoopSchema>

function extractJsonObject(text: string) {
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	if (start === -1 || end === -1 || end <= start) return null
	return text.slice(start, end + 1)
}

function parseToolLoop(content: string): PlannedToolLoop {
	const parsed = extractJsonObject(content)
	if (!parsed) {
		return {
			finalSummary: content,
		}
	}

	try {
		const json = JSON.parse(parsed)
		const result = toolLoopSchema.safeParse(json)
		if (result.success) return result.data
		return { finalSummary: content }
	} catch {
		return { finalSummary: content }
	}
}

function classifyReviewType(execution: {
	summary: string
	toolResults: Array<{ call: { name: string }; result: unknown }>
}): 'heavy' | 'quick' | 'informational' {
	const hasCodeTools = execution.toolResults.some((r) => ['shell', 'file_write', 'file_read'].includes(r.call.name))
	if (hasCodeTools) return 'heavy'
	if (execution.summary.length < 500 && execution.toolResults.length <= 1) return 'quick'
	return 'informational'
}

async function runToolLoopForTask(agent: typeof agents.$inferSelect, task: typeof agentTasks.$inferSelect) {
	const skillSummaries = await listSkillSummaries()
	const skillContext =
		skillSummaries.length > 0
			? '\nAvailable skills (use read_skill tool to load full content when relevant):\n' +
				skillSummaries
					.map((s) => {
						const fileNames = s.files.map((f) => f.name).join(', ')
						return `- ${s.name}: ${s.description}${fileNames ? ` [files: ${fileNames}]` : ''}`
					})
					.join('\n')
			: ''

	const plannerResponse = await chat(
		[
			{
				role: 'system',
				content: [
					agent.systemPrompt,
					`Your role: ${agent.role}`,
					'You may request up to 3 tools and optionally run a subagent.',
					'Return strict JSON with keys: analysis, toolCalls, finalSummary.',
					`Tool names: ${allToolNames.join(', ')}.`,
					skillContext,
				]
					.filter(Boolean)
					.join('\n'),
			},
			{
				role: 'user',
				content: `Task: ${task.title}\n\nDescription:\n${task.description}`,
			},
		],
		agent.model,
	)

	const plannerCost = await logLlmUsage({
		source: 'agent_planner',
		model: agent.model,
		tokensIn: plannerResponse.usage?.promptTokens ?? 0,
		tokensOut: plannerResponse.usage?.completionTokens ?? 0,
		metadata: { agentId: agent.id, taskId: task.id },
	}).catch(() => '0')

	const planned = parseToolLoop(plannerResponse.content)
	const requestedTools = planned.toolCalls ?? []
	const toolResults: Array<{ call: ToolCall; result: Awaited<ReturnType<typeof executeTool>> }> = []

	for (const toolCall of requestedTools.slice(0, 3)) {
		const normalizedCall: ToolCall = {
			name: toolCall.name as ToolName,
			arguments: toolCall.arguments,
		}
		const result = await executeTool(normalizedCall)
		toolResults.push({ call: normalizedCall, result })
	}

	if (toolResults.length === 0 && planned.finalSummary) {
		return {
			summary: planned.finalSummary,
			usage: plannerResponse.usage ?? {},
			toolResults,
			totalCost: plannerCost,
		}
	}

	const synthesisInput = [
		`Original task: ${task.title}`,
		`Description: ${task.description}`,
		`Agent analysis: ${planned.analysis ?? '(none provided)'}`,
		`Tool results: ${JSON.stringify(
			toolResults.map((entry) => ({ name: entry.call.name, success: entry.result.success, result: entry.result })),
		)}`,
		'Produce concise execution summary and explicit next actions.',
	].join('\n\n')

	const synthesisResponse = await chat(
		[
			{
				role: 'system',
				content: agent.systemPrompt,
			},
			{
				role: 'user',
				content: synthesisInput,
			},
		],
		agent.model,
	)

	const synthesisCost = await logLlmUsage({
		source: 'agent_synthesis',
		model: agent.model,
		tokensIn: synthesisResponse.usage?.promptTokens ?? 0,
		tokensOut: synthesisResponse.usage?.completionTokens ?? 0,
		metadata: { agentId: agent.id, taskId: task.id },
	}).catch(() => '0')

	return {
		summary: synthesisResponse.content,
		usage: {
			planner: plannerResponse.usage ?? {},
			synthesis: synthesisResponse.usage ?? {},
		},
		toolResults,
		totalCost: String(parseFloat(plannerCost) + parseFloat(synthesisCost)),
	}
}

export async function createAgentTask(input: CreateAgentTaskInput) {
	const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1)
	if (!agent) {
		throw new Error('Agent not found')
	}

	const [task] = await db
		.insert(agentTasks)
		.values({
			agentId: input.agentId,
			title: input.title.trim(),
			description: input.description.trim(),
			priority: Math.max(0, Math.min(5, input.priority ?? 2)),
			status: 'pending',
			result: {},
		})
		.returning()

	void emitActivity('task_created', `Task created: ${task.title}`, {
		entityId: task.id,
		entityType: 'task',
		metadata: { agentId: input.agentId, priority: task.priority },
	})

	return task
}

export async function delegateTaskToAgent(agentId: string, task: string, sourceTaskId?: string) {
	const created = await createAgentTask({
		agentId,
		title: sourceTaskId ? `Delegated from ${sourceTaskId.slice(0, 8)}` : 'Delegated task',
		description: task,
		priority: 3,
	})

	return {
		taskId: created.id,
		agentId,
		sourceTaskId: sourceTaskId ?? null,
	}
}

export async function createTaskForAvailableAgent(title: string, description: string) {
	const [agent] = await db
		.select()
		.from(agents)
		.where(and(eq(agents.status, 'active')))
		.orderBy(asc(agents.createdAt))
		.limit(1)

	if (!agent) {
		const [fallback] = await db
			.select()
			.from(agents)
			.where(eq(agents.status, 'idle'))
			.orderBy(asc(agents.createdAt))
			.limit(1)
		if (!fallback) {
			throw new Error('No available agent to assign task')
		}
		return createAgentTask({
			agentId: fallback.id,
			title,
			description,
			priority: 2,
		})
	}

	return createAgentTask({
		agentId: agent.id,
		title,
		description,
		priority: 2,
	})
}

export async function executeAgentTask(taskId: string) {
	const [task] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1)
	if (!task) {
		throw new Error('Task not found')
	}

	const [agent] = await db.select().from(agents).where(eq(agents.id, task.agentId)).limit(1)
	if (!agent) {
		throw new Error('Agent not found')
	}
	if (agent.status === 'paused') {
		throw new Error('Agent is paused')
	}

	await db.update(agentTasks).set({ status: 'running' }).where(eq(agentTasks.id, task.id))
	await db.update(agents).set({ status: 'active' }).where(eq(agents.id, agent.id))

	const startLog = {
		timestamp: new Date().toISOString(),
		event: 'task_started',
		taskId: task.id,
	}

	const [run] = await db
		.insert(agentRuns)
		.values({
			agentId: agent.id,
			taskId: task.id,
			logs: [startLog],
			tokenUsage: {},
		})
		.returning()

	const maxAttempts = 2
	let lastError: Error | null = null

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const execution = await runToolLoopForTask(agent, task)

			const completedLog = {
				timestamp: new Date().toISOString(),
				event: 'task_completed',
				attempt,
				toolCalls: execution.toolResults.length,
				preview: execution.summary.slice(0, 240),
			}

			const reviewType = classifyReviewType(execution)

			await db
				.update(agentTasks)
				.set({
					status: 'review',
					completedAt: new Date(),
					reviewType,
					result: {
						runId: run.id,
						summary: execution.summary,
						usage: execution.usage,
						toolResults: execution.toolResults,
						attemptCount: attempt,
						finishedAt: new Date().toISOString(),
					},
				})
				.where(eq(agentTasks.id, task.id))

			await db
				.update(agentRuns)
				.set({
					endedAt: new Date(),
					logs: [startLog, completedLog],
					tokenUsage: execution.usage,
					cost: execution.totalCost ?? '0',
				})
				.where(eq(agentRuns.id, run.id))

			await db.update(agents).set({ status: 'idle' }).where(eq(agents.id, agent.id))

			void emitActivity('task_status_changed', `Task moved to review: ${task.title}`, {
				entityId: task.id,
				entityType: 'task',
				metadata: { status: 'review', reviewType, agentId: agent.id, runId: run.id },
			})

			return {
				taskId: task.id,
				runId: run.id,
				status: 'review' as const,
				summary: execution.summary,
			}
		} catch (error) {
			lastError = error instanceof Error ? error : new Error('Unknown task execution error')
			if (attempt < maxAttempts) {
				continue
			}
		}
	}

	const failedLog = {
		timestamp: new Date().toISOString(),
		event: 'task_failed',
		error: lastError?.message ?? 'Unknown task execution error',
		attemptCount: maxAttempts,
	}

	await db
		.update(agentTasks)
		.set({
			status: 'failed',
			completedAt: new Date(),
			result: {
				runId: run.id,
				error: failedLog.error,
				attemptCount: maxAttempts,
				failedAt: new Date().toISOString(),
			},
		})
		.where(eq(agentTasks.id, task.id))

	await db
		.update(agentRuns)
		.set({
			endedAt: new Date(),
			logs: [startLog, failedLog],
		})
		.where(eq(agentRuns.id, run.id))

	await db.update(agents).set({ status: 'idle' }).where(eq(agents.id, agent.id))

	void emitActivity('task_status_changed', `Task failed: ${task.title}`, {
		entityId: task.id,
		entityType: 'task',
		metadata: { status: 'failed', agentId: agent.id, error: lastError?.message },
	})

	throw lastError ?? new Error('Task execution failed')
}

export async function getAgentDashboard(agentId: string) {
	const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
	if (!agent) {
		return null
	}

	const tasks = await db
		.select()
		.from(agentTasks)
		.where(eq(agentTasks.agentId, agentId))
		.orderBy(desc(agentTasks.createdAt))
		.limit(50)

	const runs = await db
		.select()
		.from(agentRuns)
		.where(eq(agentRuns.agentId, agentId))
		.orderBy(desc(agentRuns.startedAt))
		.limit(50)

	return { agent, tasks, runs }
}

export async function listAgentsWithCounts() {
	const rows = await db.select().from(agents).orderBy(asc(agents.createdAt))

	const taskRows = await db.select().from(agentTasks)
	const runRows = await db.select().from(agentRuns)

	return rows.map((agent) => {
		const tasks = taskRows.filter((task) => task.agentId === agent.id)
		const runs = runRows.filter((run) => run.agentId === agent.id)
		return {
			...agent,
			taskCount: tasks.length,
			pendingCount: tasks.filter((task) => task.status === 'pending').length,
			runningCount: tasks.filter((task) => task.status === 'running').length,
			reviewCount: tasks.filter((task) => task.status === 'review').length,
			runCount: runs.length,
		}
	})
}
