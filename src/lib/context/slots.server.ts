import { estimateTokens } from '$lib/tools/tools'

export type SlotTruncationStrategy = 'drop' | 'truncate-end'

export type ContextSlot = {
	name: string
	priority: number
	content: string
	tokenBudget?: number
	truncationStrategy?: SlotTruncationStrategy
}

/**
 * Per-slot overrides loaded from `context_slot_configs`. Any field set to undefined or null
 * means "use the slot's default". `enabled: false` removes the slot entirely.
 */
export type SlotOverride = {
	tokenBudget?: number | null
	priority?: number | null
	enabled?: boolean
}

/** Apply per-slot overrides to a list of slots. Slots disabled via override are dropped. */
export function applySlotOverrides(
	slots: ContextSlot[],
	overrides: Record<string, SlotOverride | undefined>,
): ContextSlot[] {
	const out: ContextSlot[] = []
	for (const slot of slots) {
		const o = overrides[slot.name]
		if (!o) {
			out.push(slot)
			continue
		}
		if (o.enabled === false) continue // disabled by user
		const merged: ContextSlot = { ...slot }
		if (typeof o.priority === 'number') merged.priority = o.priority
		if (typeof o.tokenBudget === 'number' && o.tokenBudget > 0) merged.tokenBudget = o.tokenBudget
		out.push(merged)
	}
	return out
}

export type AssembleResult = {
	systemPrompt: string
	includedSlots: string[]
	droppedSlots: string[]
	truncatedSlots: string[]
	estimatedTokens: number
}

const SLOT_SEPARATOR = '\n\n'

function truncateToTokens(content: string, maxTokens: number): string {
	if (maxTokens <= 0) return ''
	const targetChars = Math.max(0, maxTokens * 4)
	if (content.length <= targetChars) return content
	return content.slice(0, targetChars).trimEnd() + '\n\n[...truncated]'
}

export function assembleSystemPrompt(slots: ContextSlot[], budgetTokens?: number): AssembleResult {
	const usable = slots
		.filter((s) => typeof s.content === 'string' && s.content.trim().length > 0)
		.map((s, idx) => ({ slot: s, idx }))

	if (usable.length === 0) {
		return {
			systemPrompt: '',
			includedSlots: [],
			droppedSlots: [],
			truncatedSlots: [],
			estimatedTokens: 0,
		}
	}

	const droppedSlots: string[] = []
	const truncatedSlots: string[] = []
	const decisions = new Map<number, { include: boolean; content: string }>()
	for (const { slot, idx } of usable) {
		decisions.set(idx, { include: true, content: slot.content })
	}

	if (typeof budgetTokens === 'number' && Number.isFinite(budgetTokens) && budgetTokens > 0) {
		const totalNow = () =>
			usable
				.filter(({ idx }) => decisions.get(idx)?.include)
				.map(({ idx }) => decisions.get(idx)!.content)
				.reduce((sum, c) => sum + estimateTokens(c), 0)

		// First pass: try truncating slots with truncate-end strategy from lowest priority up.
		const truncationOrder = [...usable].sort(
			(a, b) => a.slot.priority - b.slot.priority || a.idx - b.idx,
		)
		for (const { slot, idx } of truncationOrder) {
			if (totalNow() <= budgetTokens) break
			if (slot.truncationStrategy !== 'truncate-end') continue
			const cap = slot.tokenBudget ?? Math.max(0, budgetTokens - totalNow() + estimateTokens(slot.content))
			const truncated = truncateToTokens(slot.content, cap)
			if (truncated.length < slot.content.length) {
				decisions.set(idx, { include: true, content: truncated })
				truncatedSlots.push(slot.name)
			}
		}

		// Second pass: drop lowest-priority slots until fit.
		for (const { slot, idx } of truncationOrder) {
			if (totalNow() <= budgetTokens) break
			const decision = decisions.get(idx)
			if (!decision?.include) continue
			decisions.set(idx, { include: false, content: '' })
			droppedSlots.push(slot.name)
		}
	}

	const includedSlots: string[] = []
	const renderedParts: string[] = []
	for (const { slot, idx } of usable) {
		const decision = decisions.get(idx)
		if (!decision?.include) continue
		includedSlots.push(slot.name)
		renderedParts.push(decision.content)
	}

	const systemPrompt = renderedParts.join(SLOT_SEPARATOR)
	return {
		systemPrompt,
		includedSlots,
		droppedSlots,
		truncatedSlots,
		estimatedTokens: estimateTokens(systemPrompt),
	}
}
