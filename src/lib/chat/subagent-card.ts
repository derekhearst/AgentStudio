/**
 * What a delegated child's card says about it at a glance (#32): how it ended, what it cost,
 * how long it took, how much it did.
 *
 * Pure, so the wording is pinned by a spec rather than by eye, and shared by the live card
 * and the persisted one. The card itself is `./SubagentBlockCard.svelte`.
 */

import type { SubagentDetails } from '../engine/tool-result-details'
import { spendTokenTotal, type SubagentSpend } from '../engine/subagent-usage'
import { transcriptFromLegacy, type SubagentTranscriptEntry } from '../engine/subagent-transcript'

export type SubagentCardStatus = 'running' | 'completed' | 'failed' | 'stopped'

/** The word next to the agent's name. A refusal reads as one, not as a crash. */
export function subagentStatusLabel(status: SubagentCardStatus, error?: string | null): string {
	if (status === 'running') return 'working…'
	if (status === 'completed') return 'done'
	if (status === 'stopped') return 'stopped'
	return error && /\brefused\b/i.test(error) ? 'refused' : 'failed'
}

/** `12.3k tokens`. */
export function formatSubagentTokens(tokens: number | null | undefined): string | null {
	if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null
	if (tokens < 1_000) return `${Math.round(tokens)} tokens`
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k tokens`
	return `${(tokens / 1_000_000).toFixed(1)}M tokens`
}

/** `4.2s`, `1m 12s`. */
export function formatSubagentDuration(ms: number | null | undefined): string | null {
	if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
	if (ms < 1_000) return `${Math.round(ms)}ms`
	const seconds = ms / 1_000
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
	const minutes = Math.floor(seconds / 60)
	return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

/**
 * The child's ledger cost. Nothing for zero: a subscription run has no per-token price, and
 * "$0.00" beside every card would read as a claim that the work was free.
 */
export function formatSubagentCost(costUsd: number | null | undefined): string | null {
	if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd <= 0) return null
	return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`
}

/**
 * The small facts under the name, in reading order, leaving out whatever is unknown.
 *
 * Tokens are every token the child's model calls used, added up (`usage`), which is what its
 * ledger row carries. A block saved before that was counted falls back to the SDK's own
 * `totalTokens`, which is only the child's last call: its context at the end plus its answer.
 */
export function subagentCardStats(input: {
	details?: SubagentDetails | null
	costUsd?: number | null
	usage?: SubagentSpend | null
	transcript: readonly SubagentTranscriptEntry[]
}): string[] {
	const toolCount =
		input.details?.totalToolUseCount ?? input.transcript.filter((entry) => entry.kind === 'tool').length
	return [
		formatSubagentTokens(spendTokenTotal(input.usage) ?? input.details?.totalTokens),
		formatSubagentCost(input.costUsd),
		formatSubagentDuration(input.details?.totalDurationMs),
		toolCount > 0 ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : null,
	].filter((part): part is string => part !== null)
}

/**
 * The entries the card's body shows. A block persisted before transcripts existed has only
 * its text and its call names; a child whose text never reached the stream still has the
 * report the SDK returned, which is better than an empty card.
 */
export function subagentCardEntries(input: {
	transcript?: readonly SubagentTranscriptEntry[] | null
	content?: string | null
	toolCalls?: ReadonlyArray<{ name: string; success?: boolean }> | null
	details?: SubagentDetails | null
}): SubagentTranscriptEntry[] {
	const entries =
		input.transcript && input.transcript.length > 0
			? [...input.transcript]
			: transcriptFromLegacy({ content: input.content, toolCalls: input.toolCalls })
	const hasText = entries.some((entry) => entry.kind === 'text' && entry.text.trim().length > 0)
	const report = input.details?.report?.trim()
	if (!hasText && report) entries.push({ kind: 'text', text: report })
	return entries
}
