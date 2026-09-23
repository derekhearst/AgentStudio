import type { ToolResultDetails } from '../engine/tool-result-details'
import type { ConversationTodoList } from '../sessions/sessions.schema'

/**
 * #21 — which tool result becomes the conversation's pinned checklist, or null for one that
 * does not.
 *
 * The panel is the agent's plan: the list the agent the user is talking to last wrote. A
 * subagent's `TodoWrite` is its own bookkeeping for the one step it was handed, and the
 * engine reports a child's tool results as well as the parent's (the ledger counts both).
 * Pinning those replaced a six-item plan with the child's three sub-steps the moment a step
 * was delegated, and kept it that way after a reload. The child's call still shows in its
 * subagent card, which is where the child's work belongs.
 *
 * Last write wins otherwise, which is what `TodoWrite` means.
 */
export function pinnedTodoListFrom(
	result: { details?: ToolResultDetails; subagentId?: string },
	runId: string,
	now: Date = new Date(),
): ConversationTodoList | null {
	if (result.details?.kind !== 'todo') return null
	if (result.subagentId) return null
	return { items: result.details.items, updatedAt: now.toISOString(), runId }
}
