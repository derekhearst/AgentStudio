import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import type { LlmMessage } from '$lib/llm/chat.server'
import { getToolDefinitions } from '$lib/tools/tools.server'
import { logLlmUsage } from '$lib/costs/usage'
import { listSkillSummaries } from '$lib/skills/skills.server'
import { recallForUser, renderMemoryContext } from '$lib/memory/memory.server'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { assembleSystemPrompt, type ContextSlot } from '$lib/context/slots.server'
import { createDetachedSession, runChatLoop } from '$lib/runtime'
import { getTaskById, recordAttempt, setTaskStatus, updateAttempt } from './tasks.server'

/**
 * Wave 2 #11 phases 3 + 5 — execute one task once, end-to-end.
 *
 * The runner: looks up the task + its owner agent, transitions the task to `running`, opens a
 * fresh `chat_runs` row + `task_attempts` row linked to the task, and routes the work through
 * `runChatLoop` with a detached Session. On success the task transitions to `completed`; on
 * thrown error the task stays where it was (caller decides whether to mark it `failed`) and
 * the attempt records the error. The `chat_runs` row and `task_attempts` row stick around as
 * forensic artifacts either way.
 *
 * Used by:
 *   - The "Retry" button on the task detail page (Phase 5).
 *   - Future automated runner that picks up `running` task children (Phase 3 follow-up).
 *
 * Requires: the task has a non-null `ownerAgentId`. We don't have a default agent for tasks
 * without an owner; the caller should ensure one is set before calling.
 */

export type ExecuteTaskOnceOptions = {
	/** Optional: route messages to a specific conversation (defaults to the task's root). */
	conversationId?: string
	/** Optional: who to attribute the run to (defaults to the task's `createdBy`). */
	userId?: string
	/** Optional: max tool rounds for this attempt (defaults to 10 — bounded since no human in the loop). */
	maxRounds?: number
}

export type ExecuteTaskOnceResult = {
	taskId: string
	attemptId: string
	runId: string
	conversationId: string
	finalText: string
	completed: boolean
	error: string | null
}

export async function executeTaskOnce(
	taskId: string,
	opts: ExecuteTaskOnceOptions = {},
): Promise<ExecuteTaskOnceResult> {
	const task = await getTaskById(taskId)
	if (!task) throw new Error(`executeTaskOnce: task ${taskId} not found`)
	if (!task.ownerAgentId) {
		throw new Error(`executeTaskOnce: task ${taskId} has no ownerAgentId — assign an agent first`)
	}
	const userId = opts.userId ?? task.createdBy
	if (!userId) {
		throw new Error(`executeTaskOnce: task ${taskId} has no createdBy and no userId override`)
	}

	const [agent] = await db.select().from(agents).where(eq(agents.id, task.ownerAgentId)).limit(1)
	if (!agent) throw new Error(`executeTaskOnce: owner agent ${task.ownerAgentId} not found`)

	// Resolve workspace context the same way the chat stream + automation engine do.
	const agentConfigForWs = agent.config as
		| {
				allowedTools?: string[]
				workspace?: {
					mode?: string
					key?: string
					repoPath?: string
					baseBranch?: string
					deleteBranchOnCleanup?: boolean
				}
		  }
		| null
	const persistentKey =
		agentConfigForWs?.workspace?.mode === 'persistent' &&
		typeof agentConfigForWs.workspace.key === 'string' &&
		agentConfigForWs.workspace.key.length > 0
			? agentConfigForWs.workspace.key
			: null
	const worktreeConfig =
		agentConfigForWs?.workspace?.mode === 'worktree' &&
		typeof agentConfigForWs.workspace.repoPath === 'string' &&
		agentConfigForWs.workspace.repoPath.length > 0
			? {
					repoPath: agentConfigForWs.workspace.repoPath,
					baseBranch: agentConfigForWs.workspace.baseBranch,
					deleteBranchOnCleanup: agentConfigForWs.workspace.deleteBranchOnCleanup,
				}
			: null
	const scopedAgentTools = Array.isArray(agentConfigForWs?.allowedTools) && agentConfigForWs.allowedTools.length > 0
		? agentConfigForWs.allowedTools
		: null

	// Pick a conversation: explicit override → task root → fresh one.
	let conversationId: string
	if (opts.conversationId) {
		conversationId = opts.conversationId
	} else if (task.rootConversationId) {
		conversationId = task.rootConversationId
	} else {
		const [created] = await db
			.insert(conversations)
			.values({
				title: task.title.slice(0, 80),
				userId,
				agentId: agent.id,
				model: agent.model,
			})
			.returning()
		conversationId = created.id
	}

	// Transition the task to running before we kick off — the UI's kanban + chat badge picks
	// this up immediately. If the task was terminal (e.g. retrying a failed task), bypass the
	// terminal-state guard via raw db update.
	if (['failed', 'blocked', 'completed', 'canceled'].includes(task.status)) {
		const { tasks: tasksTable } = await import('./tasks.schema')
		await db.update(tasksTable).set({ status: 'running', updatedAt: new Date() }).where(eq(tasksTable.id, taskId))
	} else {
		await setTaskStatus(taskId, 'running')
	}

	// Open chat_run + attempt rows linked to the task.
	const startedAt = new Date()
	const [run] = await db
		.insert(chatRuns)
		.values({
			conversationId,
			userId,
			agentId: agent.id,
			state: 'running',
			source: 'automation',
			label: `Task: ${task.title.slice(0, 80)}`,
			startedAt,
			lastHeartbeatAt: startedAt,
			taskId,
		})
		.returning({ id: chatRuns.id })

	const attempt = await recordAttempt({
		taskId,
		runId: run.id,
		status: 'running',
		startedAt,
	})
	await db.update(chatRuns).set({ taskAttemptId: attempt.id }).where(eq(chatRuns.id, run.id))

	// Build the agent's slot-based system prompt — same shape as automations.
	const slots: ContextSlot[] = [
		{ name: 'identity', priority: 100, content: agent.systemPrompt },
		{ name: 'role', priority: 95, content: `Your role: ${agent.role}` },
		{
			name: 'tool_policy',
			priority: 90,
			content: [
				'Task execution policy:',
				'- This is a scheduled task — there is no user to ask in real time.',
				'- Complete the work described in the user message, then summarize what you did.',
				'- If you cannot complete the task, leave a clear note about what is blocking you for the next manual review.',
			].join('\n'),
		},
	]

	const skillSummaries = await listSkillSummaries()
	if (skillSummaries.length > 0) {
		const text = skillSummaries.map((s) => `- ${s.name}: ${s.description}`).join('\n')
		slots.push({
			name: 'skills',
			priority: 70,
			content: `Available skills (use read_skill to load):\n${text}`,
			truncationStrategy: 'truncate-end',
		})
	}

	try {
		const settings = await getOrCreateSettings(userId)
		const memoryConfig = (settings.memoryConfig ?? null) as { enabled?: boolean; topK?: number } | null
		if (memoryConfig?.enabled !== false) {
			const recalled = await recallForUser(userId, task.spec, { topK: memoryConfig?.topK ?? 5 })
			const memoryBlock = renderMemoryContext(recalled)
			if (memoryBlock) {
				slots.push({ name: 'memory', priority: 60, content: memoryBlock, truncationStrategy: 'truncate-end' })
			}
		}
	} catch (err) {
		console.warn('[task-runner] memory recall failed', err)
	}

	const llmMessages: LlmMessage[] = [
		{ role: 'system', content: assembleSystemPrompt(slots).systemPrompt },
		{
			role: 'user',
			content: `Task: ${task.title}\n\n${task.spec}\n\nExecute this task. When you're done, summarize what you accomplished.`,
		},
	]

	const allTools = getToolDefinitions().filter((t) => t.function.name !== 'ask_user')
	const tools = scopedAgentTools
		? allTools.filter((t) => scopedAgentTools.includes(t.function.name))
		: allTools

	const session = createDetachedSession({ runId: run.id })

	try {
		const loopResult = await runChatLoop({
			session,
			userId,
			conversationId,
			model: agent.model,
			initialMessages: llmMessages,
			initialTools: tools,
			computeTools: async () => tools,
			maxRounds: opts.maxRounds ?? 10,
			approvalRequiredTools: new Set<string>(),
			isOrchestrator: false,
			persistentKey,
			worktree: worktreeConfig,
			spawnSubagent: undefined,
		})

		const finishedAt = new Date()
		const cost = await logLlmUsage({
			source: 'automation',
			model: agent.model,
			tokensIn: loopResult.promptTokens,
			tokensOut: loopResult.completionTokens,
			userId,
			runId: run.id,
			agentId: agent.id,
			taskId,
			metadata: { conversationId, taskAttemptId: attempt.id },
		}).catch(() => '0')

		await db.insert(messages).values({
			conversationId,
			role: 'assistant',
			content: loopResult.finalText || '(no output)',
			model: agent.model,
			tokensIn: loopResult.promptTokens,
			tokensOut: loopResult.completionTokens,
			cost,
			toolCalls: loopResult.toolCalls,
			metadata: {
				blocks: loopResult.streamBlocks.length > 0 ? loopResult.streamBlocks : undefined,
				taskId,
				taskAttemptId: attempt.id,
				runId: run.id,
			},
		})

		await session.updateRun({
			state: 'completed',
			label: `Task completed: ${task.title.slice(0, 80)}`,
			lastDelta: loopResult.finalText.slice(-500),
			heartbeat: true,
			finished: true,
		})

		await updateAttempt(attempt.id, {
			status: 'completed',
			finishedAt,
			costUsd: cost,
		})

		// Final transition: completed. Use raw update because setTaskStatus refuses to leave
		// terminal states, but `running` is fine.
		const { tasks: tasksTable } = await import('./tasks.schema')
		await db
			.update(tasksTable)
			.set({ status: 'completed', updatedAt: finishedAt })
			.where(eq(tasksTable.id, taskId))

		return {
			taskId,
			attemptId: attempt.id,
			runId: run.id,
			conversationId,
			finalText: loopResult.finalText,
			completed: true,
			error: null,
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Task execution failed'
		const finishedAt = new Date()

		await session.updateRun({
			state: 'failed',
			label: `Task failed: ${task.title.slice(0, 80)}`,
			error: errorMessage,
			finished: true,
		})

		await updateAttempt(attempt.id, {
			status: 'failed',
			finishedAt,
			error: errorMessage,
		})

		// Bump the task to `failed`. Raw update — bypasses setTaskStatus's terminal-state guard
		// since we're transitioning out of `running`.
		const { tasks: tasksTable } = await import('./tasks.schema')
		await db
			.update(tasksTable)
			.set({ status: 'failed', updatedAt: finishedAt })
			.where(eq(tasksTable.id, taskId))

		return {
			taskId,
			attemptId: attempt.id,
			runId: run.id,
			conversationId,
			finalText: '',
			completed: false,
			error: errorMessage,
		}
	}
}
