/**
 * What an agent's status means, in one place (#66).
 *
 * `agents.status` stores three values — `active`, `idle` and `paused` — but only one
 * distinction does anything: paused or not. A paused agent is not offered to another agent
 * for delegation (`Options.agents`), and automations and monitors do not run it. Idle and
 * active both mean available; nothing reads the difference, so the UI shows one word for
 * both rather than a distinction nobody can act on.
 *
 * Every reader of the column goes through here: the delegation filter, the automation and
 * monitor gates, every place the agents pages show a status, and the server's own check on
 * who may be paused. Pure and dependency-free, so pages and specs can import it.
 *
 * ## Who can be paused
 *
 * Only agents the user created. Two kinds are refused, because for them the rule above
 * would promise something different from what the button says:
 *
 *   built-ins    Chat, Research, Plan and Autonomous are never offered for delegation —
 *                they are the agents doing the delegating — so for them "paused" would
 *                shrink to "its automations stop". Chat is also the default agent for new
 *                conversations. A per-automation switch already does that job honestly.
 *   evaluators   the runtime runs them to grade other runs, whatever their status, and
 *                they are never offered for delegation. A Pause button on one would promise
 *                something it does not do.
 *
 * Resuming is always allowed. Before #66 the model's `pause_agent` tool could pause any
 * agent, built-ins included, and a paused agent must never be stuck without a way back.
 */

/** The status Resume writes. `idle` would read the same; `active` is what `resume_agent` has always written. */
export const AVAILABLE_AGENT_STATUS = 'active' as const
export const PAUSED_AGENT_STATUS = 'paused' as const

/** What an agent needs for the pause decision. A structural subset of an `agents` row. */
export type AgentPauseSubject = {
	builtinKey: string | null
	kind: string
}

export type AgentAvailability = 'available' | 'paused'

/** The one rule: paused, or available. `idle` and `active` are both available. */
export function isAgentPaused(status: string | null | undefined): boolean {
	return status === PAUSED_AGENT_STATUS
}

export function agentAvailability(status: string | null | undefined): AgentAvailability {
	return isAgentPaused(status) ? 'paused' : 'available'
}

/** The word every page shows for an agent's status. */
export function agentStatusLabel(status: string | null | undefined): 'Available' | 'Paused' {
	return isAgentPaused(status) ? 'Paused' : 'Available'
}

/** Why this agent may not be paused, or null when it may. See the module note. */
export function pauseRefusal(agent: AgentPauseSubject): string | null {
	if (agent.builtinKey != null) {
		return 'Built-in agents cannot be paused. They are never offered for delegation; to stop an automation, disable the automation.'
	}
	if (agent.kind === 'evaluator') {
		return 'Evaluator agents cannot be paused. The runtime runs them to grade other runs whatever their status, and they are never offered for delegation.'
	}
	return null
}

export function canPauseAgent(agent: AgentPauseSubject): boolean {
	return pauseRefusal(agent) === null
}

/**
 * The control an agent gets: Resume for any paused agent, Pause for one that may be paused,
 * and none for an available built-in or evaluator.
 */
export function agentPauseAction(agent: AgentPauseSubject & { status: string }): 'pause' | 'resume' | null {
	if (isAgentPaused(agent.status)) return 'resume'
	return canPauseAgent(agent) ? 'pause' : null
}

/** What pausing does and does not do, in the words the UI uses. */
export const AGENT_PAUSED_HELP =
	'Paused agents are not offered to other agents for delegation, and automations and monitors that use them are skipped. You can still chat with them directly.'

/** A one-line explanation of an agent's status, for a tooltip beside it. */
export function agentStatusHint(agent: AgentPauseSubject & { status: string }): string {
	if (isAgentPaused(agent.status)) return AGENT_PAUSED_HELP
	if (!canPauseAgent(agent)) {
		return agent.builtinKey != null ? 'Built-in agents are always available.' : 'Evaluator agents are always available.'
	}
	return 'Available: other agents can delegate to it, and its automations and monitors run. Pause it to stop both.'
}
