/**
 * Pure utilities for chat compaction. Server-agnostic — safe to import from tests
 * without pulling in `$env/dynamic/private` (which only resolves under the SvelteKit bundler).
 */

export type CompactableMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content?: unknown
	toolCallId?: string
	toolCalls?: Array<{ id: string; type?: string; function?: { name?: string; arguments?: string } }>
}

/**
 * Find a split index that never separates an assistant tool-call message from its tool-result messages.
 * Walks backward from the desired split point until the boundary is clean.
 *
 * `split` is the index where the "recent" (kept) slice begins. Everything before is summarized.
 *
 * Invariants after this function returns:
 * - messages[split] is never a `tool` role message (its parent assistant would be in early)
 * - messages[split - 1] is never an assistant message with non-empty toolCalls (its results would be in recent)
 *
 * If the rules force the split all the way down to 0, no compaction can safely happen — the caller
 * must detect that and skip compaction.
 */
export function findSafeSplitPoint<M extends CompactableMessage>(messages: M[], desiredSplit: number): number {
	let split = Math.max(0, Math.min(messages.length, desiredSplit))
	while (split > 0) {
		const curr = messages[split]
		const prev = messages[split - 1]
		const cuttingToolResult = curr?.role === 'tool'
		const cuttingToolCallParent =
			prev?.role === 'assistant' && Array.isArray(prev.toolCalls) && prev.toolCalls.length > 0
		if (!cuttingToolResult && !cuttingToolCallParent) break
		split--
	}
	return split
}
