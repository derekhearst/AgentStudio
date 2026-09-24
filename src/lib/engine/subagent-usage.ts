/**
 * What a delegated child actually spent (#32), added up from its own model calls.
 *
 * ## Why not the SDK's per-child figure
 *
 * A child that completes answers its `Agent` call with a typed `AgentOutput`, and its
 * `usage` looks like the child's spend. It is not. Read in the bundled CLI (2.1.278), it is
 * the usage of the child's LAST model call, and `totalTokens` is derived from that same call.
 * A child that made 30 calls reports one of them. A child that failed or was stopped reports
 * nothing at all.
 *
 * ## Where the real figure comes from
 *
 * The child's own messages reach the parent's stream (`parent_tool_use_id` set), and each
 * model call carries its usage:
 *
 *   assistant messages  one per content block. A call that wrote text and then two tool
 *                       calls arrives as three messages sharing one `message.id`, so each
 *                       call is counted once, by id.
 *   stream events       `message_start` (the call's id, input and cache tokens) and
 *                       `message_delta` (its final output count), when the producer
 *                       forwards a child's partial messages.
 *
 * Every field is merged by taking the larger figure, never by adding, because the same call
 * is reported more than once and the later reports are the more complete ones: the CLI
 * sends each content block as soon as it ends, carrying the usage known at that moment, and
 * only learns the call's final output count from `message_delta` afterwards. Taking the
 * maximum is right whichever copy is the complete one, and never counts a call twice.
 *
 * The typed result's figure is folded in the same way, as the final call's, which it is
 * exactly. So a child's total is never below what the SDK reports, and for a child whose
 * earlier calls only arrived with provisional output counts, it is a floor on the truth
 * rather than the single call it used to be.
 *
 * Pure and dependency-free (types only), so the spec can drive it directly.
 */

import type { SubagentUsage } from './tool-result-details'

/** One child's spend: every model call it made, added up. */
export type SubagentSpend = SubagentUsage & {
	/** Distinct model calls counted. */
	modelCalls: number
	/** The model the child's latest call reported, if any. */
	model: string | null
}

export type SubagentUsageTally = {
	/** A child's assistant message (the SDK message's `message`). Returns its new totals, or null if it carried no usage. */
	recordMessage(childId: string, message: unknown): SubagentSpend | null
	/** A child's partial-message stream event. Returns its new totals, or null if it carried no usage. */
	recordStreamEvent(childId: string, event: unknown): SubagentSpend | null
	/** The usage the child's typed result reports, which is its final call's. */
	recordFinalCall(childId: string, usage: SubagentUsage | null | undefined): SubagentSpend | null
	/** The child's totals so far, or null when nothing was counted for it. */
	totals(childId: string): SubagentSpend | null
}

type ChildCalls = {
	/** Call id → the fullest usage seen for it. Insertion order is call order. */
	calls: Map<string, SubagentUsage>
	/** The call a `message_delta` belongs to: the latest `message_start`. */
	streaming: string | null
	model: string | null
	anonymous: number
}

const EMPTY: SubagentUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }

function count(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** The SDK's snake_case usage object in the ledger's vocabulary. Missing fields stay null. */
function readUsage(value: unknown): { [K in keyof SubagentUsage]: number | null } | null {
	const usage = asRecord(value)
	if (!usage) return null
	const read = {
		inputTokens: count(usage.input_tokens),
		outputTokens: count(usage.output_tokens),
		cacheCreationTokens: count(usage.cache_creation_input_tokens),
		cacheReadTokens: count(usage.cache_read_input_tokens),
	}
	return Object.values(read).some((v) => v !== null) ? read : null
}

function merge(
	current: SubagentUsage | undefined,
	next: { [K in keyof SubagentUsage]: number | null } | SubagentUsage,
): SubagentUsage {
	const base = current ?? EMPTY
	return {
		inputTokens: Math.max(base.inputTokens, next.inputTokens ?? 0),
		outputTokens: Math.max(base.outputTokens, next.outputTokens ?? 0),
		cacheCreationTokens: Math.max(base.cacheCreationTokens, next.cacheCreationTokens ?? 0),
		cacheReadTokens: Math.max(base.cacheReadTokens, next.cacheReadTokens ?? 0),
	}
}

export function createSubagentUsageTally(): SubagentUsageTally {
	const children = new Map<string, ChildCalls>()

	const childFor = (childId: string): ChildCalls => {
		let child = children.get(childId)
		if (!child) {
			child = { calls: new Map(), streaming: null, model: null, anonymous: 0 }
			children.set(childId, child)
		}
		return child
	}

	const totals = (childId: string): SubagentSpend | null => {
		const child = children.get(childId)
		if (!child || child.calls.size === 0) return null
		const sum = { ...EMPTY }
		for (const call of child.calls.values()) {
			sum.inputTokens += call.inputTokens
			sum.outputTokens += call.outputTokens
			sum.cacheCreationTokens += call.cacheCreationTokens
			sum.cacheReadTokens += call.cacheReadTokens
		}
		return { ...sum, modelCalls: child.calls.size, model: child.model }
	}

	const record = (
		childId: string,
		callId: string | null,
		usage: { [K in keyof SubagentUsage]: number | null },
		model: unknown,
	): SubagentSpend | null => {
		const child = childFor(childId)
		// A message with no id cannot be matched to its siblings; count it on its own.
		const key = callId ?? `anonymous-${child.anonymous++}`
		child.calls.set(key, merge(child.calls.get(key), usage))
		if (typeof model === 'string' && model.trim()) child.model = model
		return totals(childId)
	}

	return {
		recordMessage(childId, message) {
			const m = asRecord(message)
			const usage = readUsage(m?.usage)
			if (!m || !usage) return null
			return record(childId, typeof m.id === 'string' && m.id ? m.id : null, usage, m.model)
		},
		recordStreamEvent(childId, event) {
			const ev = asRecord(event)
			if (ev?.type === 'message_start') {
				const m = asRecord(ev.message)
				const id = typeof m?.id === 'string' && m.id ? m.id : null
				childFor(childId).streaming = id
				const usage = readUsage(m?.usage)
				return usage ? record(childId, id, usage, m?.model) : null
			}
			if (ev?.type === 'message_delta') {
				const usage = readUsage(ev.usage)
				const id = children.get(childId)?.streaming ?? null
				// A delta with no start to belong to would be counted as a call of its own.
				if (!usage || !id) return null
				return record(childId, id, usage, null)
			}
			return null
		},
		recordFinalCall(childId, usage) {
			if (!usage) return totals(childId)
			const child = childFor(childId)
			const last = [...child.calls.keys()].at(-1) ?? 'final'
			child.calls.set(last, merge(child.calls.get(last), usage))
			return totals(childId)
		},
		totals,
	}
}

/** Every token a spend covers, for a card's "N tokens". */
export function spendTokenTotal(spend: SubagentUsage | null | undefined): number | null {
	if (!spend) return null
	const total = spend.inputTokens + spend.outputTokens + spend.cacheCreationTokens + spend.cacheReadTokens
	return total > 0 ? total : null
}
