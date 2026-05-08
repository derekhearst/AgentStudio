/**
 * Persisted reasoning-effort selection.
 *
 * Stored in localStorage so the user's last choice carries across reloads and
 * across conversations within the same session. Per-conversation overrides
 * (chat/[id] page) layer a `${KEY}:${conversationId}` slot above the global
 * key so each conversation can remember its own effort independently.
 *
 * Cross-environment safe — every read/write checks `typeof window` so the
 * helpers can be imported from server-side code without crashing on SSR.
 */

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export const REASONING_STORAGE_KEY = 'AgentStudio:reasoning-effort'

export const VALID_REASONING_EFFORTS: readonly ReasoningEffort[] = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
]

function isBrowser(): boolean {
	return typeof window !== 'undefined'
}

function isValidEffort(value: string | null | undefined): value is ReasoningEffort {
	return !!value && (VALID_REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * Load the user's last reasoning-effort choice. When `conversationId` is
 * supplied, prefer the per-conversation slot; fall back to the global slot
 * when that's empty. Returns null if neither slot has a valid value.
 */
export function loadReasoningEffort(conversationId?: string | null): ReasoningEffort | null {
	if (!isBrowser()) return null
	if (conversationId) {
		const scoped = window.localStorage.getItem(`${REASONING_STORAGE_KEY}:${conversationId}`)
		if (isValidEffort(scoped)) return scoped
	}
	const global = window.localStorage.getItem(REASONING_STORAGE_KEY)
	return isValidEffort(global) ? global : null
}

/**
 * Persist the user's reasoning-effort choice. Always writes the global slot;
 * also writes the per-conversation slot when `conversationId` is supplied.
 */
export function saveReasoningEffort(effort: ReasoningEffort, conversationId?: string | null): void {
	if (!isBrowser()) return
	window.localStorage.setItem(REASONING_STORAGE_KEY, effort)
	if (conversationId) {
		window.localStorage.setItem(`${REASONING_STORAGE_KEY}:${conversationId}`, effort)
	}
}
