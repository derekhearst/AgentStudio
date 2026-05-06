import { eq, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import type { LlmMessage } from '$lib/llm/chat.server'
import { logLlmUsage } from '$lib/costs/usage'
import { buildAgentDefinition, createDetachedSession, runChatLoop } from '$lib/runtime'
import { runEvaluatorPass } from '$lib/evaluations'
import type { EvaluationVerdict, EvaluationFinding } from '$lib/evaluations/evaluations.schema'
import { getTaskById, recordAttempt, setTaskStatus, updateAttempt } from './tasks.server'
import { insertMessageWithSequence } from '$lib/chat/insert-message.server'

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
	/**
	 * Wave 3 #14 evaluations plan phase 3 — when set, the runner will spawn up to N re-plan
	 * attempts on `needs_revision` verdicts. Caps the recursion since each retry costs another
	 * generator + evaluator pair. Defaults to 0 (no auto-retry; just records the verdict and
	 * blocks the task) so existing callers don't suddenly start spending more.
	 */
	maxRetriesOnRevision?: number
	/** Internal counter — tracked so retries don't grow the call stack via recursion. */
	_currentRetry?: number
	/** Internal — append previous findings to the user message so the evaluator's signal isn't lost. */
	_priorFindings?: EvaluationFinding[]
}

export type ExecuteTaskOnceResult = {
	taskId: string
	attemptId: string
	runId: string
	conversationId: string
	finalText: string
	completed: boolean
	error: string | null
	/** Wave 3 #14 — verdict from the post-run evaluator, if `task.evalRequired` was true. */
	evaluationVerdict?: EvaluationVerdict | null
	/** Wave 3 #14 phase 3 — number of revision retries the runner spawned. 0 if no re-plan happened. */
	retries?: number
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

	// Wave 2 #10 phase 2 — slot assembly + workspace context resolved by the runtime.
	const definition = await buildAgentDefinition({
		agent,
		userId,
		intent: task.spec,
		toolPolicy: [
			'Task execution policy:',
			'- This is a scheduled task — there is no user to ask in real time.',
			'- Complete the work described in the user message, then summarize what you did.',
			'- If you cannot complete the task, leave a clear note about what is blocking you for the next manual review.',
		].join('\n'),
	})

	// Wave 5 #19 phase 2 finish — when the task is linked to a repository, materialize
	// the local mirror + override the agent's worktree config so runChatLoop checks out
	// the real repo on a per-attempt branch. Failure here is non-fatal: the runner falls
	// back to the agent's legacy workspace + logs a warning so the task still runs (with
	// the agent's normal sandbox surface, just without a real git checkout).
	const currentRetry = opts._currentRetry ?? 0
	let provisionedWorktree: typeof definition.worktree = definition.worktree
	if (task.repositoryId) {
		try {
			const { provisionRepoBackedWorkspace } = await import(
				'$lib/source-control/repo-worktree.server'
			)
			const provisioned = await provisionRepoBackedWorkspace({
				userId,
				taskId,
				attemptNumber: currentRetry + 1,
				repositoryId: task.repositoryId,
			})
			provisionedWorktree = provisioned.worktree
		} catch (err) {
			console.warn('[task-runner] repo-backed workspace provisioning failed; falling back to agent workspace', {
				taskId,
				repositoryId: task.repositoryId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

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

	// Open chat_run + attempt rows linked to the task. Wave 3 #14 phase 4 — propagate the task's
	// `evalRequired` flag to the chat_run so the run viewer + future ad-hoc evaluator queries can
	// rely on it (and so isRunEvaluationClear can short-circuit when the task didn't ask for one).
	const startedAt = new Date()
	const [run] = await db
		.insert(chatRuns)
		.values({
			conversationId,
			userId,
			agentId: agent.id,
			state: 'running',
			source: 'automation',
			label: `Task: ${task.title.slice(0, 80)}${currentRetry > 0 ? ` (retry ${currentRetry})` : ''}`,
			startedAt,
			lastHeartbeatAt: startedAt,
			taskId,
			evalRequired: task.evalRequired,
			evalAttempt: currentRetry,
		})
		.returning({ id: chatRuns.id })

	const attempt = await recordAttempt({
		taskId,
		runId: run.id,
		status: 'running',
		startedAt,
	})
	await db.update(chatRuns).set({ taskAttemptId: attempt.id }).where(eq(chatRuns.id, run.id))

	// Wave 3 #14 phase 3 — inject prior evaluator findings on retry so the next attempt has the
	// guidance it needs to course-correct.
	const priorFindingsText = opts._priorFindings && opts._priorFindings.length > 0
		? `\n\n## Prior evaluator feedback\nYour previous attempt was marked needs_revision. Address these findings before completing:\n${opts._priorFindings
				.map((f, i) => `${i + 1}. [${f.severity}${f.category ? `/${f.category}` : ''}] ${f.message}${f.suggestion ? ` — Suggestion: ${f.suggestion}` : ''}`)
				.join('\n')}`
		: ''
	const llmMessages: LlmMessage[] = [
		{ role: 'system', content: definition.systemPrompt },
		{
			role: 'user',
			content: `Task: ${task.title}\n\n${task.spec}${priorFindingsText}\n\nExecute this task. When you're done, summarize what you accomplished.`,
		},
	]

	const session = createDetachedSession({ runId: run.id })

	try {
		const loopResult = await runChatLoop({
			session,
			userId,
			conversationId,
			model: agent.model,
			initialMessages: llmMessages,
			initialTools: definition.tools,
			computeTools: async () => definition.tools,
			maxRounds: opts.maxRounds ?? 10,
			approvalRequiredTools: new Set<string>(),
			isOrchestrator: false,
			agentId: agent.id,
			persistentKey: definition.persistentKey,
			worktree: provisionedWorktree,
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

		await insertMessageWithSequence({
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

		// Wave 3 #14 phase 4 — task-completion gate. If the task asked for an evaluator pass, run
		// it synchronously (unlike chat-stream's fire-and-forget) so the task transition can
		// depend on the verdict.
		const { tasks: tasksTable } = await import('./tasks.schema')
		let evaluationVerdict: EvaluationVerdict | null = null
		if (task.evalRequired) {
			const toolSummary = loopResult.toolCalls.length > 0
				? loopResult.toolCalls.map((c) => (c as { name?: string }).name).filter(Boolean).join(', ')
				: undefined
			const evalRow = await runEvaluatorPass({
				runId: run.id,
				userId,
				conversationId,
				taskDescription: `${task.title}\n\n${task.spec}`,
				generatorOutput: loopResult.finalText,
				toolSummary,
			}).catch((err) => {
				console.warn('[tasks] evaluator pass failed', err)
				return null
			})
			evaluationVerdict = evalRow?.verdict ?? null

			// Wave 3 #14 phase 3 — re-plan loop on `needs_revision`. Spawns a fresh attempt with
			// the prior findings as context, capped by `maxRetriesOnRevision`. Recursion-free —
			// uses `_currentRetry` + `_priorFindings` to thread state through a sequential call.
			const maxRetries = opts.maxRetriesOnRevision ?? 0
			if (
				evaluationVerdict === 'needs_revision' &&
				maxRetries > 0 &&
				currentRetry < maxRetries
			) {
				// Bump the task's retry counter durably so the UI can show "attempt 2 of 3".
				await db
					.update(tasksTable)
					.set({ evalAttempt: drizzleSql`${tasksTable.evalAttempt} + 1`, status: 'running', updatedAt: new Date() })
					.where(eq(tasksTable.id, taskId))
				const retryResult = await executeTaskOnce(taskId, {
					conversationId,
					userId,
					maxRounds: opts.maxRounds,
					maxRetriesOnRevision: maxRetries,
					_currentRetry: currentRetry + 1,
					_priorFindings: evalRow?.findings ?? [],
				})
				return {
					...retryResult,
					retries: (retryResult.retries ?? 0) + 1,
				}
			}

			// Pass → completed; fail/needs_revision (no retries left) → blocked so a human can
			// triage. The verdict is durable in `run_evaluations` either way.
			if (evaluationVerdict === 'pass') {
				await db.update(tasksTable).set({ status: 'completed', updatedAt: finishedAt }).where(eq(tasksTable.id, taskId))
			} else {
				await db.update(tasksTable).set({ status: 'blocked', updatedAt: finishedAt }).where(eq(tasksTable.id, taskId))
				return {
					taskId,
					attemptId: attempt.id,
					runId: run.id,
					conversationId,
					finalText: loopResult.finalText,
					completed: false,
					error: `evaluator verdict: ${evaluationVerdict ?? 'unknown'}`,
					evaluationVerdict,
					retries: currentRetry,
				}
			}
		} else {
			// No eval required → original behavior, unconditional completion.
			await db.update(tasksTable).set({ status: 'completed', updatedAt: finishedAt }).where(eq(tasksTable.id, taskId))
		}

		return {
			taskId,
			attemptId: attempt.id,
			runId: run.id,
			conversationId,
			finalText: loopResult.finalText,
			completed: true,
			error: null,
			evaluationVerdict,
			retries: currentRetry,
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
