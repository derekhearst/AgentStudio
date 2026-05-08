/**
 * Shared shape for the per-tool handler functions extracted from `tools.server.ts`.
 *
 * Every handler is `(call, ctx) => Promise<ToolHandlerResult>`. The dispatcher in
 * `tools.server.ts` runs every handler inside `toolUserContext.run(...)`, so handlers
 * can read the per-run context (worktree, runId, runtime) via `toolUserContext.getStore()`
 * directly without it being passed in.
 *
 * The `ctx` parameter carries the extras the dispatcher resolved before calling the
 * handler — `userId` (always present), `runId` (nullable), and `startedAt` (epoch ms,
 * for the executionMs delta the handler reports back).
 */

import type { ToolCall } from './tool-call'

export type ToolHandlerCtx = {
	userId: string
	runId: string | null
	startedAt: number
}

export type ToolHandlerResult = {
	success: boolean
	tool: string
	input?: unknown
	result?: unknown
	error?: string
	executionMs: number
}

export type ToolHandler = (
	call: ToolCall,
	ctx: ToolHandlerCtx,
) => Promise<ToolHandlerResult>
