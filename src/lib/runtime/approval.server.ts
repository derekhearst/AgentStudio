import { randomUUID } from 'node:crypto'
import { enqueuePendingApproval, awaitApprovalDecision } from '$lib/runs/approvals.server'
import { executeTool, type ToolCallWithContext, type WorkspaceOptions } from '$lib/tools/tools.server'
import type { Session } from './types'

/**
 * Mirrors the inline approval block in `runChatLoop` (loop.server.ts:209-257) so callers other
 * than the main loop — currently the `run_code` handler dispatching nested tool calls from a
 * sandboxed script — can enforce identical approval semantics. Both paths funnel through the
 * same DB-backed `enqueuePendingApproval` / `awaitApprovalDecision`, so an operator approving
 * a nested call in /review or via the SSE `tool_pending` event resolves it the same way as a
 * top-level call.
 */
export type ExecuteToolWithApprovalInput = {
	call: ToolCallWithContext
	userId: string
	runId: string
	/** ID used in `tool_pending` / `tool_denied` events so the UI can correlate. */
	toolCallId: string
	approvalRequiredTools: ReadonlySet<string>
	/** Raw JSON-string of the args, surfaced in tool_pending. Defaults to JSON.stringify(call.arguments). */
	rawArguments?: string
	session?: Pick<Session, 'emit' | 'updateRun'> | null
	workspace?: WorkspaceOptions
}

export type ExecuteToolWithApprovalResult =
	| { denied: true; reason: 'user_denied' }
	| { denied: false; result: Awaited<ReturnType<typeof executeTool>> }

export async function executeToolWithApproval(
	input: ExecuteToolWithApprovalInput,
): Promise<ExecuteToolWithApprovalResult> {
	const { call, userId, runId, toolCallId, approvalRequiredTools, session, workspace } = input
	const requiresApproval = approvalRequiredTools.has('*') || approvalRequiredTools.has(call.name)

	if (requiresApproval) {
		const approvalToken = randomUUID()
		await enqueuePendingApproval(
			runId,
			{
				token: approvalToken,
				toolName: call.name,
				args: call.arguments,
				requestedAt: new Date().toISOString(),
			},
			{
				state: 'waiting_tool_approval',
				label: `Waiting for approval: ${call.name}`,
			},
		)
		if (session) {
			await session.emit('tool_pending', {
				token: approvalToken,
				id: toolCallId,
				name: call.name,
				arguments: input.rawArguments ?? JSON.stringify(call.arguments),
			})
		}
		const approved = await awaitApprovalDecision(runId, approvalToken)
		if (session) {
			await session.updateRun({
				state: 'running',
				label: approved ? `Executing ${call.name}` : `Denied ${call.name}`,
				heartbeat: true,
			})
		}
		if (!approved) {
			if (session) {
				await session.emit('tool_denied', { id: toolCallId, name: call.name })
			}
			return { denied: true, reason: 'user_denied' }
		}
	}

	const result = await executeTool(call, userId, runId, workspace)
	return { denied: false, result }
}
