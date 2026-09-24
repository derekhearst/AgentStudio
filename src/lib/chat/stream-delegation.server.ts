/**
 * The delegation gate for one chat turn (#32), wired to this app's budget gate.
 *
 * `$lib/engine/delegation-gate` decides admission and knows nothing about budgets or
 * agents; this supplies the check a child must pass before it starts. It is the very gate a
 * chat turn passes (`enforceBudgetGuard`), so a blocked child records the same alert and
 * opens the same review item a blocked chat does — scoped to the child's own agent, whose
 * limits the parent's check never looked at.
 *
 * A child with no `agents` row of ours (the SDK's built-in general-purpose, Explore and Plan
 * agents) is checked, and later charged, as the parent's agent — see `$lib/costs/subagent-ledger`.
 */

import { createDelegationGate, type DelegationGate } from '$lib/engine/delegation-gate'
import { enforceBudgetGuard } from './stream-prep.server'

export type ChatDelegationGateInput = {
	userId: string
	conversationId: string
	/** The parent's agent as the ledger knows it (`conversations.agent_id`). */
	parentAgentId: string | null
	/** From `loadSubagentRoster`: which `agents` row each offered key names. */
	agentIdByKey: Readonly<Record<string, string>>
	parentIsClaude: boolean
}

/** The `agents` row a child's budget and ledger row are scoped to. */
export function childAgentId(
	agentKey: string | null,
	input: Pick<ChatDelegationGateInput, 'agentIdByKey' | 'parentAgentId'>,
): string | null {
	return (agentKey ? input.agentIdByKey[agentKey] : undefined) ?? input.parentAgentId
}

export function createChatDelegationGate(input: ChatDelegationGateInput): DelegationGate {
	return createDelegationGate({
		parentIsClaude: input.parentIsClaude,
		checkChildBudget: async (agentKey) => {
			const verdict = await enforceBudgetGuard({
				userId: input.userId,
				agentId: childAgentId(agentKey, input),
				conversationId: input.conversationId,
			})
			if (!verdict.blocked) return { allowed: true }
			return {
				allowed: false,
				reason: `Refused: ${verdict.payload.message}. The delegated agent was not started. Do not retry it; tell the user the budget is exhausted.`,
			}
		},
	})
}
