/**
 * Bridges AgentStudio's existing tool surface onto the Claude Agent SDK.
 *
 * Nothing about the tools themselves changes: `toolSchemas` is already a map of
 * Zod objects and `executeTool` already owns context setup, name normalisation,
 * error shaping and cost tracking. All this does is re-register them as SDK
 * tools so the Agent SDK's loop can call them in-process.
 *
 * That is the whole point of the migration — the loop becomes Anthropic's, the
 * tools stay ours.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { toolSchemas, toolDescriptions, allToolNames, type ToolName } from '$lib/tools/tool-schemas'
import { ENGINE_EXCLUDED_TOOLS } from './builtin-tools'
// Re-exported because this module is where callers look for the engine's tool surface,
// even though the list itself lives with the other tool-name data so specs can read it
// without pulling in the server surface.
export { ENGINE_EXCLUDED_TOOLS } from './builtin-tools'
import { executeTool, type WorkspaceOptions } from '$lib/tools/tools.server'

/** MCP namespaces tool names as `mcp__<server>__<tool>`. */
export const ENGINE_MCP_SERVER = 'agentstudio'

export function qualifiedToolName(name: string): string {
	return `mcp__${ENGINE_MCP_SERVER}__${name}`
}

/** Strip the MCP namespace so the rest of the app keeps seeing bare tool names. */
export function bareToolName(qualified: string): string {
	const prefix = `mcp__${ENGINE_MCP_SERVER}__`
	return qualified.startsWith(prefix) ? qualified.slice(prefix.length) : qualified
}

export type ToolExecutionRecord = {
	name: string
	success: boolean
	executionMs: number
	result?: unknown
	error?: string
}

export type AskUserQuestion = {
	header: string
	question: string
	options?: Array<{ label: string; description?: string; recommended?: boolean }>
}

export type ToolServerContext = {
	userId: string
	runId: string | null
	workspace?: WorkspaceOptions
	/**
	 * Fulfils `ask_user`. The registry's handler is a deliberate stub — the old
	 * chat loop special-cased the tool, so without a host implementation the
	 * model just gets "cannot run directly" back. Resolves once the user answers.
	 */
	onAskUser?: (questions: AskUserQuestion[]) => Promise<string>
	/**
	 * Fired after every tool finishes. The stream layer uses this to emit
	 * `tool_result` frames without having to re-derive the outcome.
	 */
	onExecuted?: (record: ToolExecutionRecord) => void
}

/**
 * Build the in-process MCP server exposing the registry's tools.
 *
 * Built per-run rather than at module scope because the handlers close over
 * `userId` / `runId` / workspace, which differ for every chat run.
 *
 * `only` is a scoped agent's in-house tools (`./tool-scope`). A tool outside it is not
 * registered at all, which is what makes a read-only agent read-only: the model cannot
 * call a tool that does not exist, whatever the approval settings say.
 */

export function buildToolServer(ctx: ToolServerContext, only?: ReadonlySet<string> | null) {
	const tools = allToolNames
		.filter((name: ToolName) => !ENGINE_EXCLUDED_TOOLS.has(name))
		.filter((name: ToolName) => !only || only.has(name))
		.map((name: ToolName) =>
			tool(
				name,
				toolDescriptions[name],
				// The SDK wants a raw Zod shape, not the ZodObject wrapper.
				toolSchemas[name].shape,
				async (args: Record<string, unknown>) => {
					if (name === 'ask_user' && ctx.onAskUser) {
						const questions = (args.questions ?? []) as AskUserQuestion[]
						const answer = await ctx.onAskUser(questions)
						return { content: [{ type: 'text' as const, text: answer }] }
					}

					const outcome = await executeTool({ name, arguments: args }, ctx.userId, ctx.runId, ctx.workspace)

					ctx.onExecuted?.({
						name,
						success: outcome.success,
						executionMs: outcome.executionMs,
						result: outcome.result,
						error: outcome.error,
					})

					// Failures come back as tool output rather than thrown errors so the
					// model can read them and recover, which is how the old loop behaved.
					const text = outcome.success
						? typeof outcome.result === 'string'
							? outcome.result
							: JSON.stringify(outcome.result ?? null)
						: (outcome.error ?? 'Tool failed with no error message')

					return {
						content: [{ type: 'text' as const, text }],
						...(outcome.success ? {} : { isError: true as const }),
					}
				},
			),
		)

	return createSdkMcpServer({
		name: ENGINE_MCP_SERVER,
		version: '1.0.0',
		tools,
		instructions: "AgentStudio's tool surface.",
	})
}
