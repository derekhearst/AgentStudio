/**
 * Maps AgentStudio's `agents` rows onto the SDK's `Options.agents` (#5).
 *
 * The migration left subagents on the old hand-written loop (`$lib/agents/inline-subagent`
 * → `$lib/runtime`), which is why `$lib/runtime` cannot be deleted (#8) and why a
 * multi-agent conversation loses its inline rendering. The SDK has native subagents: define
 * them here, and the model delegates by calling the `Task` tool.
 *
 * This module is the pure half — row in, `AgentDefinition` out — so the decisions below can
 * be read and tested without a database.
 *
 * ## The decisions, and why
 *
 * **A paused agent is not offered.** `agents.status` is the only thing that column currently
 * does anywhere in the app (#66 notes it is rendered in three places and settable in none),
 * and "paused" has to mean something. Excluding it here is the one place it can.
 *
 * **`ask_user` is disallowed for every subagent.** The old loop refused it for
 * non-orchestrators — a child has no stream to ask down — and that rule has to survive the
 * port or a delegated agent will hang waiting for an answer nobody is being shown.
 *
 * **The model is inherited unless the row asks for a Claude model.** A run against the
 * gateway sets `ANTHROPIC_MODEL` for the whole process, so a subagent naming a different
 * backend cannot get one; it would either be ignored or billed to the wrong place. Naming a
 * model only when the parent run is on the Claude CLI keeps that honest, and `'inherit'`
 * is a documented value rather than a guess.
 */

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
	/** From `agents.config.allowedTools` when the agent has a fixed surface; null for all tools. */
	allowedTools?: readonly string[] | null
}

/** Tools no subagent may call, whatever its own allow-list says. */
export const SUBAGENT_DISALLOWED_TOOLS: readonly string[] = [
	// A child has no stream to ask down. The old loop refused this for non-orchestrators;
	// without it a delegated agent hangs on a question nobody is shown.
	'mcp__agentstudio__ask_user',
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

/** True when a model id is one the Claude CLI serves directly, rather than via the gateway. */
function isClaudeModelId(model: string): boolean {
	const normalized = model.toLowerCase()
	const bare = normalized.startsWith('anthropic/') ? normalized.slice('anthropic/'.length) : normalized
	return ['claude-', 'opus', 'sonnet', 'haiku'].some((prefix) => bare.startsWith(prefix))
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
	if (row.status === 'paused') return null

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

	if (row.model && isClaudeModelId(row.model) && options.parentIsClaude) {
		definition.model = row.model.includes('/') ? row.model.split('/').slice(1).join('/') : row.model
	} else {
		definition.model = 'inherit'
	}

	if (row.allowedTools && row.allowedTools.length > 0) {
		definition.tools = [...row.allowedTools]
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
