/**
 * Streaming-block types + pure inspection helpers used by the chat page.
 *
 * The chat stream produces four kinds of incremental blocks: text deltas, tool
 * calls (with their lifecycle status), reasoning/thinking content, and
 * sub-agent spans. The page owns the `$state<StreamingBlock[]>` array; these
 * helpers are pure functions that take the array as input so they can be
 * unit-tested and reused (e.g. for serializing to message metadata, computing
 * stats, or building the persistence payload on stop / error).
 */

import { parseJsonFallback } from '$lib/chat/tool-block-helpers'

export type ToolStatus = 'pending' | 'approved' | 'executing' | 'completed' | 'failed' | 'denied'

export type TextBlock = {
	kind: 'text'
	id: string
	content: string
}

export type ToolBlock = {
	kind: 'tool'
	id: string
	name: string
	arguments: string
	status: ToolStatus
	result?: string
	executionMs?: number | null
	expanded: boolean
	token?: string | null
}

export type ThinkingBlock = {
	kind: 'thinking'
	id: string
	content: string
	reasoningTokens?: number | null
	expanded: boolean
}

export type SubagentBlock = {
	kind: 'subagent'
	id: string
	agentId: string
	agentName: string
	conversationId: string | null
	task: string
	content: string
	status: 'running' | 'completed' | 'failed'
	toolCalls: Array<{ name: string; success?: boolean }>
	expanded: boolean
}

export type StreamingBlock = TextBlock | ToolBlock | ThinkingBlock | SubagentBlock

/** Concatenate all text-block content. Used to surface the full assistant draft. */
export function getPartialText(blocks: StreamingBlock[]): string {
	return blocks
		.filter((b): b is TextBlock => b.kind === 'text')
		.map((b) => b.content)
		.join('')
}

/** Concatenate all thinking-block content with paragraph breaks between turns. */
export function getThinkingText(blocks: StreamingBlock[]): string {
	return blocks
		.filter((b): b is ThinkingBlock => b.kind === 'thinking')
		.map((b) => b.content)
		.join('\n\n')
}

/** Find the most recent thinking block's `reasoningTokens` count, if any. */
export function getLatestReasoningTokens(blocks: StreamingBlock[]): number | null {
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i]
		if (block.kind === 'thinking' && typeof block.reasoningTokens === 'number') {
			return block.reasoningTokens
		}
	}
	return null
}

/**
 * Build the metadata payload that gets persisted on the assistant message row.
 * Drops empty text/thinking blocks (they're noise in the persisted history) and
 * normalizes tool blocks into `{ name, arguments, result, success, executionMs }`.
 */
export function getSerializableBlocksForMetadata(blocks: StreamingBlock[]): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = []
	for (const block of blocks) {
		if (block.kind === 'text') {
			if (!block.content.trim()) continue
			out.push({ kind: 'text', content: block.content })
		} else if (block.kind === 'thinking') {
			if (!block.content.trim()) continue
			out.push({
				kind: 'thinking',
				content: block.content,
				reasoningTokens: block.reasoningTokens ?? null,
			})
		} else if (block.kind === 'subagent') {
			out.push({
				kind: 'subagent',
				agentId: block.agentId,
				agentName: block.agentName,
				conversationId: block.conversationId,
				task: block.task,
				content: block.content,
				success: block.status === 'completed',
			})
		} else {
			out.push({
				kind: 'tool',
				name: block.name,
				arguments: parseJsonFallback(block.arguments),
				result: block.result ?? '',
				success: block.status === 'completed',
				executionMs: block.executionMs ?? 0,
			})
		}
	}
	return out
}

/** Tool blocks whose lifecycle has reached a terminal state, normalized for callers that need a flat list. */
export function getCompletedToolCalls(blocks: StreamingBlock[]): Array<Record<string, unknown>> {
	return blocks
		.filter(
			(b): b is ToolBlock =>
				b.kind === 'tool' && (b.status === 'completed' || b.status === 'failed' || b.status === 'denied'),
		)
		.map((b) => ({
			name: b.name,
			arguments: parseJsonFallback(b.arguments),
			result: b.result ?? '',
			status: b.status,
		}))
}

/** Cheap token estimate for prompt-budget UI. Mirrors the server fallback (chars / 4). */
export function estimateTokens(value: string | null | undefined): number {
	return Math.max(0, Math.ceil((value?.length ?? 0) / 4))
}

type MaybeSequenced = { sequence?: number | null }
type RemoteUserShape = { role: string; content: string; createdAt: Date | string }

type PendingUser = { id: string; content: string; createdAt: Date }
type PendingAssistant = {
	id: string
	content: string
	createdAt: Date
	toolCalls?: Array<Record<string, unknown>>
}

/**
 * Merge remote DB-backed messages with optimistic / pending drafts and sort by
 * per-conversation `sequence`.
 *
 * Optimistic user drafts are dropped once the matching DB row appears
 * (content + recency match within 15s). Pending assistant drafts are dropped
 * once their id is in the remote set. Drafts without a server-assigned
 * sequence get sentinel values near `Number.MAX_SAFE_INTEGER` so they sort to
 * the end while a streaming turn is in flight; once the real row lands its
 * sequence takes over.
 */
export function buildDisplayedMessages<R extends RemoteUserShape & MaybeSequenced & { id: string }>(input: {
	remoteMessages: R[]
	pendingUserMessages: PendingUser[]
	pendingAssistantDrafts: PendingAssistant[]
	model: string
}): Array<R | ReturnType<typeof buildOptimisticUser> | ReturnType<typeof buildPendingAssistant>> {
	const { remoteMessages, pendingUserMessages, pendingAssistantDrafts, model } = input
	const remoteIds = new Set(remoteMessages.map((m) => m.id))
	let pendingSeq = Number.MAX_SAFE_INTEGER - 10000

	const optimisticUsers = pendingUserMessages
		.filter(
			(message) =>
				!remoteMessages.some(
					(remote) =>
						remote.role === 'user' &&
						remote.content === message.content &&
						new Date(remote.createdAt).getTime() >= message.createdAt.getTime() - 15000,
				),
		)
		.map((message) => buildOptimisticUser(message, model, ++pendingSeq))

	const pendingAssistants = pendingAssistantDrafts
		.filter((message) => !remoteIds.has(message.id))
		.map((message) => buildPendingAssistant(message, model, ++pendingSeq))

	const combined = [...remoteMessages, ...optimisticUsers, ...pendingAssistants]
	combined.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
	return combined
}

/**
 * Drop pending optimistic drafts that have been confirmed by the server, plus
 * any older-than-60-second leftovers (covers stream-error cases where `done`
 * never landed).
 *
 * Assistant drafts are dropped when:
 *   - their id matches a remote message (id-rewrite via compaction/branching), OR
 *   - their content matches a recent (within 15s) remote assistant message, OR
 *   - they're older than 60 seconds (phantom-bubble guard).
 *
 * User drafts are dropped when their content matches a recent remote user
 * message — the server-assigned id replaces the client-side temp id.
 *
 * Pure function — returns the filtered arrays without mutating inputs.
 */
export function reconcilePendingDrafts<RemoteMsg extends RemoteUserShape & { id: string }>(input: {
	pendingAssistantDrafts: PendingAssistant[]
	pendingUserMessages: PendingUser[]
	remoteMessages: RemoteMsg[]
	now?: number
}): {
	pendingAssistantDrafts: PendingAssistant[]
	pendingUserMessages: PendingUser[]
} {
	const now = input.now ?? Date.now()
	const STALE_DRAFT_MS = 60_000
	const RECENCY_MATCH_MS = 15_000

	const pendingAssistantDrafts = input.pendingAssistantDrafts.filter((draft) => {
		if (input.remoteMessages.some((message) => message.id === draft.id)) return false
		const matchesByContent =
			draft.content.trim().length > 0 &&
			input.remoteMessages.some(
				(remote) =>
					remote.role === 'assistant' &&
					remote.content === draft.content &&
					new Date(remote.createdAt).getTime() >= draft.createdAt.getTime() - RECENCY_MATCH_MS,
			)
		if (matchesByContent) return false
		if (now - draft.createdAt.getTime() > STALE_DRAFT_MS) return false
		return true
	})
	const pendingUserMessages = input.pendingUserMessages.filter(
		(pending) =>
			!input.remoteMessages.some(
				(remote) =>
					remote.role === 'user' &&
					remote.content === pending.content &&
					new Date(remote.createdAt).getTime() >= pending.createdAt.getTime() - RECENCY_MATCH_MS,
			),
	)

	return { pendingAssistantDrafts, pendingUserMessages }
}

function buildOptimisticUser(message: PendingUser, model: string, sequence: number) {
	return {
		id: message.id,
		role: 'user' as const,
		content: message.content,
		model,
		tokensIn: 0,
		tokensOut: 0,
		cost: '0',
		ttftMs: null,
		totalMs: null,
		tokensPerSec: null,
		createdAt: message.createdAt,
		sequence,
		toolCalls: [] as Array<Record<string, unknown>>,
	}
}

function buildPendingAssistant(message: PendingAssistant, model: string, sequence: number) {
	return {
		id: message.id,
		role: 'assistant' as const,
		content: message.content,
		model,
		tokensIn: 0,
		tokensOut: 0,
		cost: '0',
		ttftMs: null,
		totalMs: null,
		tokensPerSec: null,
		createdAt: message.createdAt,
		sequence,
		toolCalls: message.toolCalls ?? [],
	}
}
