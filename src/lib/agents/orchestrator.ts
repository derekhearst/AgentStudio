import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { skills } from '$lib/skills/skills.schema'
import { expandFragments } from '$lib/agents/fragment-expand'
import { logger } from '$lib/observability/logger'

/**
 * Orchestrator identity — injected as system message for conversations
 * where agentId IS NULL (direct user↔orchestrator chat).
 *
 * The persona text below is the canonical content. To customize per-deploy without a code
 * change, create a custom agent in /agents and set it as the user's default — orchestrator
 * mode runs only when no agent is bound.
 */

export const ORCHESTRATOR_IDENTITY_DEFAULT = `You are the Orchestrator — the user's primary AI assistant in AgentStudio.

Your responsibilities:
- Answer questions directly when you can (simple path)
- For complex, multi-step work, propose a plan with specific agents before executing
- Delegate sub-tasks to specialized agents when their expertise is needed
- Synthesize sub-agent results into coherent responses

Behavior:
- Be concise and helpful. Don't over-explain.
- When a task is simple (lookup, chat, brainstorming), handle it yourself — no plan needed.
- When a task is complex (multi-step, needs tools, specialized knowledge), propose a plan first.
- Plans list the steps and which agent handles each. Wait for user approval before executing.
- After sub-agents complete, synthesize their results and present a unified response.
`

async function loadOrchestratorIdentity(): Promise<string> {
	// Phase 5 — expand `@import skill-name` fragments. Best-effort: a lookup failure
	// leaves a `<!-- @import:missing ... -->` marker rather than throwing.
	try {
		return await expandFragments(ORCHESTRATOR_IDENTITY_DEFAULT, lookupFragmentByName)
	} catch (err) {
		logger.warn('[orchestrator] fragment expansion failed, using raw content', { err })
		return ORCHESTRATOR_IDENTITY_DEFAULT
	}
}

async function lookupFragmentByName(name: string): Promise<string | null> {
	try {
		const [row] = await db
			.select({ content: skills.content, enabled: skills.enabled })
			.from(skills)
			.where(eq(skills.name, name))
			.limit(1)
		if (!row || !row.enabled) return null
		return row.content
	} catch {
		return null
	}
}

/**
 * How the orchestrator learns who it can delegate to (#66).
 *
 * This used to be a roster of its own: every agent with `status = 'active'`, named by an
 * eight-character id prefix. Nothing sets a custom agent `active` except resuming it, so on
 * a fresh install the roster listed only the Default Evaluator — which is never offered for
 * delegation — and left out every agent the same run did pass to the SDK. The prompt and
 * `Options.agents` disagreed, and the id prefix was not a name the delegation tool accepts.
 *
 * The SDK already describes each `Options.agents` entry in the `Agent` tool's own
 * description, keyed by the name it takes as `subagent_type`. So the prompt points there
 * instead of keeping a second list that can drift from it. Built before the run's agents are
 * loaded, which is why it cannot name them itself.
 */
export const ORCHESTRATOR_DELEGATION_NOTE =
	"Delegation: the agents you can hand work to are listed in the Agent tool's description, each under the name you pass as `subagent_type`. Those are the only agents that exist for this. If none are listed, do the work yourself."

/**
 * Build the orchestrator system prompt: the identity, plus where to find the agents it may
 * delegate to.
 */
export async function buildOrchestratorPrompt(): Promise<string> {
	const identity = await loadOrchestratorIdentity()
	return [identity, ORCHESTRATOR_DELEGATION_NOTE].join('\n\n')
}
