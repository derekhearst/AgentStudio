/**
 * Maps AgentStudio's `agents` rows onto the SDK's `Options.agents` (#5).
 *
 * The migration left subagents on the old hand-written loop (`$lib/agents/inline-subagent`,
 * now deleted → `$lib/runtime`), reached by an in-house `run_subagent` tool that dispatched on an
 * `agentId` — a uuid nothing ever put in the model's context, so it could name an agent
 * only by guessing one. The SDK has native subagents: define them here, and the model
 * delegates by calling `Task` with a key it was actually told about.
 *
 * This module is the pure half — row in, `AgentDefinition` out — so the decisions below can
 * be read and tested without a database. `./agent-definitions.server` decides which agents
 * a run is offered; `buildEngineOptions` puts the result in `Options.agents`.
 *
 * ## The decisions, and why
 *
 * **A paused agent is not offered.** That is half of what pausing means (#66); the other half
 * is that automations and monitors skip it. The rule itself — paused or available, with
 * `idle` and `active` both available — lives in `$lib/agents/agent-status`, which the Pause
 * button, the automation gate and this filter all read.
 *
 * **`AskUserQuestion` is disallowed for every subagent.** The old loop refused `ask_user` for
 * non-orchestrators — a child has no stream to ask down — and that rule survived the port to
 * the SDK's own question tool (#4). The engine refuses a child's question in `canUseTool` as
 * well, for the SDK's built-in agents, which no definition here reaches.
 *
 * **The model is inherited unless the row asks for a Claude model.** A run against the
 * gateway sets `ANTHROPIC_MODEL` for the whole process, so a subagent naming a different
 * backend cannot get one; it would either be ignored or billed to the wrong place. Naming a
 * model only when the parent run is on the Claude CLI keeps that honest, and `'inherit'`
 * is a documented value rather than a guess.
 */

import { isAgentPaused } from '$lib/agents/agent-status'
import { BUILTIN_TOOL_SET } from './builtin-tools'
import { ASK_USER_QUESTION_TOOL } from './ask-user-question'
import { isSubscriptionModel, normalizeModelId } from './model-backend'
import { OWN_MCP_SERVER } from './permission-mode'

/** The subset of `AgentDefinition` this app populates. Mirrors the SDK type structurally. */
export type EngineAgentDefinition = {
	description: string
	prompt: string
	model?: string
	tools?: string[]
	disallowedTools?: string[]
}

/** What the mapper needs from an `agents` row, named so callers cannot pass the wrong thing. */
export type AgentRowForDefinition = {
	name: string
	role: string
	/** Already resolved — an identity skill may have overridden `systemPrompt`. */
	prompt: string
	model: string | null
	status: string
	/**
	 * From `agents.config.allowedTools` when the agent has a fixed surface; null for all
	 * tools. Bare names — `qualifyAgentTools` namespaces them on the way into a definition.
	 */
	allowedTools?: readonly string[] | null
}

/**
 * Name an agent's fixed tool surface the way the SDK sees it.
 *
 * `agents.config.allowedTools` holds bare names, and this app's own tools are served by an
 * in-process MCP server — so an unqualified `file_write` in a subagent's `tools` list
 * matches nothing, and the SDK reads "no tool matched" as an agent with no tools at all
 * rather than as a mistake. The SDK's built-ins are already unqualified and must be left
 * alone. Same transformation `buildEngineOptions` applies to the parent's `allowedTools`.
 */
export function qualifyAgentTools(allowedTools: readonly string[]): string[] {
	return allowedTools.map((name) => (BUILTIN_TOOL_SET.has(name) ? name : `mcp__${OWN_MCP_SERVER}__${name}`))
}

/** Tools no subagent may call, whatever its own allow-list says. */
export const SUBAGENT_DISALLOWED_TOOLS: readonly string[] = [
	// A child has no stream to ask down. The old loop refused its `ask_user` for
	// non-orchestrators; the SDK's question tool is refused the same way.
	ASK_USER_QUESTION_TOOL,
]

/**
 * Turn an agent's name into a key the model can name in a `Task` call.
 *
 * Lowercase kebab, because the key appears in tool input and a name with spaces or
 * punctuation invites the model to mis-type it. Collisions are the caller's problem — see
 * `buildAgentDefinitions`.
 */
export function agentKey(name: string): string {
	const slug = String(name ?? '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return slug.length > 0 ? slug : 'agent'
}

/**
 * Build one definition, or null when the agent must not be offered.
 *
 * `parentIsClaude` is whether the parent run is on the Claude CLI rather than the gateway;
 * see the module note on why a subagent only names a model in that case.
 */
export function agentDefinitionFrom(
	row: AgentRowForDefinition,
	options: { parentIsClaude: boolean },
): { key: string; definition: EngineAgentDefinition } | null {
	if (isAgentPaused(row.status)) return null

	const prompt = row.prompt?.trim()
	if (!prompt) return null

	// `description` is documented as "when to use this agent" — it is what the model reads to
	// choose one, so the role belongs in it rather than the name alone.
	const role = row.role?.trim()
	const description = role ? `${row.name.trim()} — ${role}` : row.name.trim()

	const definition: EngineAgentDefinition = {
		description,
		prompt,
		disallowedTools: [...SUBAGENT_DISALLOWED_TOOLS],
	}

	// The same normalisation the parent's model gets, so `anthropic/claude-haiku-4.5` reaches
	// the CLI as `claude-haiku-4-5` whichever of the two it was named in. A Claude id the CLI
	// cannot run (a retired model) inherits instead of failing the delegation.
	if (row.model && isSubscriptionModel(row.model) && options.parentIsClaude) {
		definition.model = normalizeModelId(row.model)
	} else {
		definition.model = 'inherit'
	}

	if (row.allowedTools && row.allowedTools.length > 0) {
		definition.tools = qualifyAgentTools(row.allowedTools)
	}

	return { key: agentKey(row.name), definition }
}

/**
 * Build the whole map, dropping what cannot be offered and de-duplicating keys.
 *
 * Two agents named "Reviewer" and "reviewer!" both slug to `reviewer`. The first wins and
 * the second is skipped rather than silently replacing it: a `Task` call naming `reviewer`
 * should reach the same agent on every turn, and "last write wins" over a `Record` would
 * make that depend on row order.
 */
export function buildAgentDefinitions(
	rows: readonly AgentRowForDefinition[],
	options: { parentIsClaude: boolean },
): Record<string, EngineAgentDefinition> {
	const out: Record<string, EngineAgentDefinition> = {}
	for (const row of rows) {
		const built = agentDefinitionFrom(row, options)
		if (!built) continue
		if (built.key in out) continue
		out[built.key] = built.definition
	}
	return out
}
