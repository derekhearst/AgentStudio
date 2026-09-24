/**
 * Per-tool-call dispatch helpers extracted from `runtime/loop.server.ts`.
 *
 * The loop's per-round body executes each pending tool call serially. The original code had
 * inline branches (`ask_user`, `run_subagent`, normal tool dispatch) plus an approval check,
 * all repetitive emit/pushBlock/result-shaping. Each branch is a coherent unit (build result →
 * emit → push block → return record for state arrays); `dispatchToolCall` chains them. The
 * `run_subagent` branch went with the in-house subagents (#5, #8).
 *
 * Each handler returns a `ToolHandlerOutcome` — the record to append to `toolResults` (LLM
 * messages) and `allToolCalls` (cost / activity rollups). The loop layer pushes those into the
 * appropriate accumulators; this file owns no mutable state.
 *
 * Side effects (session.emit, session.pushBlock, session.updateRun) happen INSIDE these helpers
 * exactly as they did in the inline code. Behavior is identical — this is a pure refactor.
 */

import { trimToolResult } from '$lib/chat/chat'
import { trimToolResultWithOffload } from '$lib/tools/output-offload.server'
import { enqueuePendingApproval, awaitApprovalDecision } from '$lib/runs/approvals.server'
import { enqueuePendingQuestion, awaitQuestionAnswers } from '$lib/runs/questions.server'
import {
	executeTool,
	toolSchemas,
	type ToolCallWithContext,
	type ToolName,
} from '$lib/tools/tools.server'
import { emitHook } from '$lib/hooks'
import { logger } from '$lib/observability/logger'
import { NOT_OFFERED_REASON, notOfferedMessage } from './offered-tools'
import type { Session } from './types'

export type PlannedToolCall = {
	id: string
	name: string
	arguments: string
	parsedArgs: unknown
}

export type ToolHandlerOutcome = {
	toolResult: { call_id: string; name: string; result: string }
	allToolCallsEntry: Record<string, unknown>
}

export type ApprovalOutcome =
	| { kind: 'not_required' }
	| { kind: 'approved' }
	| { kind: 'denied'; outcome: ToolHandlerOutcome }

export type DispatchContext = NormalToolContext & {
	/** The tool names this run offered the model (`offeredToolNames(input.tools)`). */
	offeredTools: ReadonlySet<string>
	approvalRequiredTools: ReadonlySet<string>
	isOrchestrator: boolean
}

/**
 * Run one planned call through every gate, in order: the offered list, approval, then
 * `ask_user` or the registry. A name the run did not offer is refused before anything else,
 * so it never reaches an approval card or `executeTool` (see `./offered-tools`).
 */
export async function dispatchToolCall(ctx: DispatchContext, tc: PlannedToolCall): Promise<ToolHandlerOutcome> {
	const { session } = ctx
	if (!ctx.offeredTools.has(tc.name)) return refuseUnofferedCall(session, tc)

	// ── Approval gate (no-op when no approval required).
	const approval = await checkToolApproval(session, tc, ctx.approvalRequiredTools)
	if (approval.kind === 'denied') return approval.outcome

	// ── ask_user (orchestrator-only). Self-contained: emits + pushes block inside.
	if (tc.name === 'ask_user') return handleAskUserCall(session, tc, ctx.isOrchestrator)

	await session.updateRun({
		state: 'running',
		label: `Executing ${tc.name}`,
		heartbeat: true,
	})
	await session.emit('tool_call', { id: tc.id, name: tc.name, arguments: tc.arguments })

	// ── normal tool dispatch
	return handleNormalToolCall(ctx, tc)
}

/** Refuse a call to a tool the run never offered, without running or queueing it. */
export async function refuseUnofferedCall(session: Session, tc: PlannedToolCall): Promise<ToolHandlerOutcome> {
	const resultStr = JSON.stringify({ error: notOfferedMessage(tc.name) })
	const refused = { denied: true, reason: NOT_OFFERED_REASON }
	await session.emit('tool_result', {
		id: tc.id,
		name: tc.name,
		success: false,
		executionMs: 0,
		result: resultStr,
	})
	await session.pushBlock({
		kind: 'tool',
		name: tc.name,
		arguments: tc.parsedArgs,
		result: refused,
		success: false,
		executionMs: 0,
	})
	return {
		toolResult: { call_id: tc.id, name: tc.name, result: resultStr },
		allToolCallsEntry: { name: tc.name, arguments: tc.parsedArgs, result: refused, executionMs: 0 },
	}
}

/**
 * If this tool requires approval (per-tool or wildcard), enqueue + await the decision.
 * Returns `not_required` when no approval is needed, `approved` to fall through to execution,
 * or `denied` with a pre-built outcome the loop can append directly without calling the tool.
 */
export async function checkToolApproval(
	session: Session,
	tc: PlannedToolCall,
	approvalRequiredTools: ReadonlySet<string>,
): Promise<ApprovalOutcome> {
	const requiresApproval =
		approvalRequiredTools.has('*') || approvalRequiredTools.has(tc.name)
	if (!requiresApproval) return { kind: 'not_required' }

	const approvalToken = crypto.randomUUID()
	// Bundle the pendingApprovals enqueue + state transition in a single transaction
	// (inside enqueuePendingApproval) so a crash between the two never leaves the run
	// in `running` state with an invisible pending approval, or vice versa.
	await enqueuePendingApproval(
		session.runId,
		{
			token: approvalToken,
			toolName: tc.name,
			args: tc.parsedArgs,
			requestedAt: new Date().toISOString(),
		},
		{
			state: 'waiting_tool_approval',
			label: `Waiting for approval: ${tc.name}`,
		},
	)
	await session.emit('tool_pending', {
		token: approvalToken,
		id: tc.id,
		name: tc.name,
		arguments: tc.arguments,
	})
	const approved = await awaitApprovalDecision(session.runId, approvalToken)
	await session.updateRun({
		state: 'running',
		label: approved ? `Executing ${tc.name}` : `Denied ${tc.name}`,
		heartbeat: true,
	})
	if (approved) return { kind: 'approved' }

	await session.emit('tool_denied', { id: tc.id, name: tc.name })
	return {
		kind: 'denied',
		outcome: {
			toolResult: {
				call_id: tc.id,
				name: tc.name,
				result: 'Tool execution was denied by user.',
			},
			allToolCallsEntry: {
				name: tc.name,
				arguments: tc.parsedArgs,
				result: { denied: true },
				executionMs: 0,
			},
		},
	}
}

/** Handle an `ask_user` tool call. Routes through pendingQuestions + awaits answers. */
export async function handleAskUserCall(
	session: Session,
	tc: PlannedToolCall,
	isOrchestrator: boolean,
): Promise<ToolHandlerOutcome> {
	if (!isOrchestrator) {
		const resultStr = trimToolResult(
			tc.name,
			JSON.stringify({
				error:
					'Agents cannot ask users directly. Return this question to the orchestrator to gather user input, then resume the agent with those answers.',
			}),
		)
		await session.emit('tool_result', {
			id: tc.id,
			name: tc.name,
			success: false,
			executionMs: 0,
			result: resultStr,
		})
		await session.pushBlock({
			kind: 'tool',
			name: tc.name,
			arguments: tc.parsedArgs,
			result: { denied: true, reason: 'ask_user is restricted to orchestrator conversations' },
			success: false,
			executionMs: 0,
		})
		return {
			toolResult: { call_id: tc.id, name: tc.name, result: resultStr },
			allToolCallsEntry: {
				name: tc.name,
				arguments: tc.parsedArgs,
				result: { denied: true, reason: 'ask_user is restricted to orchestrator conversations' },
				executionMs: 0,
			},
		}
	}

	let askInput: ReturnType<typeof toolSchemas.ask_user.parse>
	try {
		askInput = toolSchemas.ask_user.parse(tc.parsedArgs)
	} catch {
		const errorMessage = 'ask_user received invalid arguments.'
		const resultStr = trimToolResult(tc.name, JSON.stringify({ error: errorMessage }))
		await session.emit('tool_result', {
			id: tc.id,
			name: tc.name,
			success: false,
			executionMs: 0,
			result: resultStr,
		})
		return {
			toolResult: { call_id: tc.id, name: tc.name, result: resultStr },
			allToolCallsEntry: {
				name: tc.name,
				arguments: tc.parsedArgs,
				result: { error: errorMessage },
				executionMs: 0,
			},
		}
	}

	const questionToken = crypto.randomUUID()
	await enqueuePendingQuestion(
		session.runId,
		{
			token: questionToken,
			questions: askInput.questions,
			requestedAt: new Date().toISOString(),
		},
		{ state: 'waiting_user_input', label: 'Waiting for user input' },
	)
	await session.emit('ask_user', {
		token: questionToken,
		id: tc.id,
		name: tc.name,
		questions: askInput.questions,
	})
	const answers = await awaitQuestionAnswers(session.runId, questionToken)
	await session.updateRun({
		state: 'running',
		label: 'User input received',
		heartbeat: true,
	})

	const questionResult = {
		questions: askInput.questions,
		answers,
		timedOut: answers === null,
	}
	const resultStr = trimToolResult(tc.name, JSON.stringify(questionResult))
	await session.emit('tool_result', {
		id: tc.id,
		name: tc.name,
		success: answers !== null,
		executionMs: 0,
		result: resultStr,
	})
	await session.pushBlock({
		kind: 'tool',
		name: tc.name,
		arguments: tc.parsedArgs,
		result: questionResult,
		success: answers !== null,
		executionMs: 0,
	})
	return {
		toolResult: { call_id: tc.id, name: tc.name, result: resultStr },
		allToolCallsEntry: {
			name: tc.name,
			arguments: tc.parsedArgs,
			result: questionResult,
			executionMs: 0,
		},
	}
}

export type NormalToolContext = {
	session: Session
	userId: string
	conversationId: string
	agentId?: string | null
	persistentKey: string | null
	worktree: { repoPath: string; baseBranch?: string; deleteBranchOnCleanup?: boolean } | null
	projectId: string | null
}

/** Handle a normal tool call (anything registered in `toolSchemas`). */
export async function handleNormalToolCall(
	ctx: NormalToolContext,
	tc: PlannedToolCall,
): Promise<ToolHandlerOutcome> {
	const { session } = ctx
	const toolCall: ToolCallWithContext = {
		name: tc.name as ToolName,
		arguments: tc.parsedArgs,
		conversationId: ctx.conversationId,
		messageId: null,
	}

	void emitHook('before_tool', {
		runId: session.runId,
		conversationId: ctx.conversationId,
		userId: ctx.userId,
		agentId: ctx.agentId ?? null,
		toolName: tc.name,
		args: tc.parsedArgs,
	})

	const toolResult = await executeTool(toolCall, ctx.userId, session.runId, {
		persistentKey: ctx.persistentKey,
		worktree: ctx.worktree,
		projectId: ctx.projectId,
	})

	void emitHook('after_tool', {
		runId: session.runId,
		conversationId: ctx.conversationId,
		userId: ctx.userId,
		agentId: ctx.agentId ?? null,
		toolName: tc.name,
		args: tc.parsedArgs,
		result: toolResult.success ? toolResult.result : { error: toolResult.error },
		success: toolResult.success,
		durationMs: toolResult.executionMs,
	})

	void (async () => {
		try {
			const { appendTraceSpan } = await import('$lib/observability/traces.server')
			await appendTraceSpan(session.runId, {
				kind: 'tool_call',
				startedAt: new Date(Date.now() - toolResult.executionMs).toISOString(),
				durationMs: toolResult.executionMs,
				success: toolResult.success,
				toolName: tc.name,
			})
		} catch (err) {
			logger.warn('[runtime] appendTraceSpan failed (non-fatal)', { err })
		}
	})()

	const rawResultStr = toolResult.success
		? JSON.stringify(toolResult.result)
		: `Error: ${toolResult.error}`
	const trimmed = await trimToolResultWithOffload({
		toolName: tc.name,
		content: rawResultStr,
		callId: tc.id,
		userId: ctx.userId,
		runId: session.runId,
		persistentKey: ctx.persistentKey,
		worktree: ctx.worktree,
		// Same root `executeTool` just ran the tool in, above.
		projectId: ctx.projectId,
	})
	const resultStr = trimmed.visible

	await session.emit('tool_result', {
		id: tc.id,
		name: tc.name,
		success: toolResult.success,
		executionMs: toolResult.executionMs,
		result: resultStr,
		offloadedHandle: trimmed.handle,
		fullSize: trimmed.fullSize,
	})
	await session.pushBlock({
		kind: 'tool',
		name: tc.name,
		arguments: tc.parsedArgs,
		result: toolResult.success ? toolResult.result : { error: toolResult.error },
		success: toolResult.success,
		executionMs: toolResult.executionMs,
	})

	return {
		toolResult: { call_id: tc.id, name: tc.name, result: resultStr },
		allToolCallsEntry: {
			name: tc.name,
			arguments: tc.parsedArgs,
			result: toolResult.success ? toolResult.result : { error: toolResult.error },
			success: toolResult.success,
			executionMs: toolResult.executionMs,
		},
	}
}
