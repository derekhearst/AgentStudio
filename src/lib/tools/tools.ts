import { allToolNames, toolDescriptions } from './tool-schemas'
import { ENGINE_EXCLUDED_TOOLS, HOST_OWNED_TOOLS } from '$lib/engine/builtin-tools'

type ToolName = string

/**
 * Wave 5 #19 phase 3 finish — tools that ALWAYS require human approval, regardless of the
 * user's per-tool approval-mode setting. These are tools whose blast radius reaches outside
 * AgentStudio (pushing commits to a third-party SCM, opening pull requests on GitHub, etc.).
 *
 * The chat-stream handler unions this set into the runtime's `approvalRequiredTools`, so an
 * operator can never accidentally turn approval off for these. Tool execution branches also
 * refuse when the run has no approval surface (e.g. detached automation runs), so the same
 * tool registered into an automation handler will fail-closed instead of silently pushing.
 */
export const MANDATORY_APPROVAL_TOOLS: readonly ToolName[] = [
	'push_branch',
	'create_pull_request',
	// Plan-approval handoff: the planner asks the user to confirm the plan file and switch
	// the conversation's bound agent to the implementer. Always requires explicit approval —
	// in detached/automation runs the tool fails closed.
	'request_plan_approval',
]

/**
 * Model context window sizes (in tokens), for the context figures a chat run reports.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	'claude-sonnet-5': 200_000,
	'claude-opus-5': 200_000,
	'openai/gpt-4o-mini': 128_000,
}

export function getContextWindowSize(model: string): number {
	return MODEL_CONTEXT_WINDOWS[model] ?? 200_000
}

/**
 * Rough token estimate: chars / 4. Model-agnostic and synchronous, for the context slots'
 * budgets (`$lib/context/slots.server`); a chat run's real counts come from the engine.
 */
export function estimateTokens(text: string): number {
	return Math.ceil((text?.length ?? 0) / 4)
}

/**
 * The registry tools a chat run can call, for the settings approval list. Every one of them
 * can be marked as needing approval, one by one.
 *
 * Derived rather than listed: names and descriptions come from `tool-schemas.ts`, and the
 * tools the engine does not register (`ENGINE_EXCLUDED_TOOLS`) or never gates
 * (`HOST_OWNED_TOOLS` — `ask_user` is the question itself, handed to the host before any
 * gate runs) are left out, because a setting that cannot take effect is a false promise.
 *
 * The list used to be grouped into an "always loaded" tier, whose chips could not be
 * toggled, and a "searchable" tier — both described the old loop's deferred loading, which
 * the chat engine never had (#8).
 */
export type BuiltinTool = {
	name: string
	description: string
}

export const BUILTIN_TOOLS: BuiltinTool[] = allToolNames
	.filter((name) => !ENGINE_EXCLUDED_TOOLS.has(name) && !HOST_OWNED_TOOLS.has(name))
	.map((name) => ({ name, description: toolDescriptions[name] ?? '' }))
	.sort((a, b) => a.name.localeCompare(b.name))

/**
 * Registry tools that only work inside a chat run, so the MCP endpoint neither lists nor runs
 * them. `/api/mcp` calls a tool with no run at all, and each of these refuses without one:
 *
 *   - `HOST_OWNED_TOOLS` (`ask_user`): the question is answered in the chat's own card; run
 *     directly, the handler can only say it is not directly executable.
 *   - `MANDATORY_APPROVAL_TOOLS`: they refuse anywhere nobody can press Allow, which is
 *     every call that is not part of an interactive chat run.
 *   - `set_project_context`: it changes the project of the conversation the run belongs to,
 *     and an MCP call belongs to none.
 */
export const CHAT_RUN_ONLY_TOOLS: ReadonlySet<string> = new Set([
	...HOST_OWNED_TOOLS,
	...MANDATORY_APPROVAL_TOOLS,
	'set_project_context',
])

/**
 * The registry tools `/api/mcp` offers and will run. Listing a tool that always refuses is
 * the same false promise as a setting that cannot take effect.
 */
export function mcpExposedToolNames(): typeof allToolNames {
	return allToolNames.filter((name) => !CHAT_RUN_ONLY_TOOLS.has(name))
}
