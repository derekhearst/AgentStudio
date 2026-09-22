/**
 * Loads the agents a run may delegate to, as `Options.agents` (#5).
 *
 * The impure half of `./agent-definitions`: this one reaches the database, resolves each
 * agent's identity the same way the parent's own prompt is resolved, and MCP-qualifies the
 * tool names. Every decision about *what* a definition contains lives in the pure module
 * and is pinned by `tests/engine.agent-definitions.spec.ts`.
 *
 * ## Which agents are offered
 *
 * Delegation used to be `run_subagent`, an in-house tool the orchestrator called with an
 * `agentId` it had to already know. Nothing put that id in its context: the model was told
 * a tool existed for dispatching to agents and given no way to name one, so in practice it
 * either guessed or never called it. `Options.agents` inverts that — every offered agent is
 * described in the system prompt with the name the `Task` tool takes.
 *
 * That inversion is also why the list has to be short. Each definition costs its
 * description in every request, so this offers at most `MAX_SUBAGENTS`, newest first.
 *
 * Excluded, and why:
 *
 *   built-ins      chat / research / plan / autonomous are orchestrator personas — the
 *                  thing doing the delegating, not a delegate.
 *   evaluators     spawned by the runtime after a run with a structured-output contract
 *                  (#14). A `Task` call would not honour it.
 *   the run's own  delegating to yourself is a loop with extra steps.
 *   paused         `agents.status`, the one place it means anything — see the pure module.
 *
 * ## Only orchestrators delegate
 *
 * A worker agent gets no `agents` map, which is the rule the old loop enforced
 * (`isOrchestrator && input.spawnSubagent`) carried over unchanged. A worker that could
 * delegate would also contradict the posture slot it is given.
 */

import { and, desc, isNull, ne } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents as agentsTable } from '$lib/agents/agents.schema'
import { loadAgentIdentityContent } from '$lib/chat/agent-switch.server'
import { logger } from '$lib/observability/logger'
import { buildAgentDefinitions, type EngineAgentDefinition } from './agent-definitions'

/** How many agents may be described to the model at once. See the module note. */
export const MAX_SUBAGENTS = 12

function configAllowedTools(config: unknown): string[] | null {
	const allowed = (config as { allowedTools?: unknown } | null)?.allowedTools
	if (!Array.isArray(allowed) || allowed.length === 0) return null
	const names = allowed.filter((name): name is string => typeof name === 'string' && name.length > 0)
	return names.length > 0 ? names : null
}

export type SubagentLoadInput = {
	/** The run's own agent, excluded from its own delegate list. */
	parentAgentId: string
	/** False for a worker agent, which is offered nothing. See the module note. */
	parentIsOrchestrator: boolean
	/** Whether the parent runs on the Claude CLI — decides if a child may name a model. */
	parentIsClaude: boolean
}

/**
 * Build the `Options.agents` map for a run. Never throws: a failure here costs delegation,
 * and losing the turn over it would be a worse trade.
 */
export async function loadSubagentDefinitions(
	input: SubagentLoadInput,
): Promise<Record<string, EngineAgentDefinition>> {
	if (!input.parentIsOrchestrator) return {}

	try {
		const rows = await db
			.select({
				id: agentsTable.id,
				name: agentsTable.name,
				role: agentsTable.role,
				systemPrompt: agentsTable.systemPrompt,
				identitySkillId: agentsTable.identitySkillId,
				model: agentsTable.model,
				status: agentsTable.status,
				config: agentsTable.config,
			})
			.from(agentsTable)
			.where(
				and(
					isNull(agentsTable.builtinKey),
					ne(agentsTable.kind, 'evaluator'),
					ne(agentsTable.id, input.parentAgentId),
					ne(agentsTable.status, 'paused'),
				),
			)
			.orderBy(desc(agentsTable.createdAt))
			.limit(MAX_SUBAGENTS)

		const resolved = await Promise.all(
			rows.map(async (row) => {
				const allowedTools = configAllowedTools(row.config)
				return {
					name: row.name,
					role: row.role,
					// The same resolution the parent's identity slot uses, so editing an agent's
					// identity skill changes how it behaves as a delegate too.
					prompt: await loadAgentIdentityContent(row),
					model: row.model,
					status: row.status,
					allowedTools,
				}
			}),
		)

		return buildAgentDefinitions(resolved, { parentIsClaude: input.parentIsClaude })
	} catch (err) {
		logger.warn('[engine] failed to load subagent definitions; delegation disabled for this run', { err })
		return {}
	}
}
