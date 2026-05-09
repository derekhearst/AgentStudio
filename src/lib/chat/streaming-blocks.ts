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

/**
 * Mark a tool block as `denied` after the user rejects an approval prompt.
 * Pure transform — mutates nothing. Returns the same array shape (with one
 * block updated) when the id matches, else returns the input unchanged.
 */
export function applyToolDenied(blocks: StreamingBlock[], toolId: string): StreamingBlock[] {
	return blocks.map((b) =>
		b.kind === 'tool' && b.id === toolId ? { ...b, status: 'denied' as const, expanded: true } : b,
	)
}

export type SubagentStartPayload = {
	agentId: string
	agentName: string
	conversationId: string | null
	task?: string
}

/**
 * Append a new subagent block. Collapses any open thinking blocks so the new
 * subagent span gets visual focus.
 */
export function applySubagentStart(
	blocks: StreamingBlock[],
	payload: SubagentStartPayload,
): StreamingBlock[] {
	return [
		...blocks.map((b) => (b.kind === 'thinking' ? { ...b, expanded: false } : b)),
		{
			kind: 'subagent' as const,
			id: `subagent-${payload.agentId}-${payload.conversationId}`,
			agentId: payload.agentId,
			agentName: payload.agentName,
			conversationId: payload.conversationId,
			task: payload.task ?? '',
			content: '',
			status: 'running' as const,
			toolCalls: [],
			expanded: true,
		},
	]
}

type SubagentTargetMatch = { agentId: string; conversationId: string | null }

/** Append a delta chunk to the currently-running subagent block matching the target. */
export function applySubagentDelta(
	blocks: StreamingBlock[],
	target: SubagentTargetMatch,
	content: string,
): StreamingBlock[] {
	return blocks.map((b) =>
		b.kind === 'subagent' &&
		b.agentId === target.agentId &&
		b.conversationId === target.conversationId
			? { ...b, content: b.content + content }
			: b,
	)
}

/** Append a tool call entry to the matching subagent block. */
export function applySubagentToolCall(
	blocks: StreamingBlock[],
	target: SubagentTargetMatch,
	name: string,
): StreamingBlock[] {
	return blocks.map((b) =>
		b.kind === 'subagent' &&
		b.agentId === target.agentId &&
		b.conversationId === target.conversationId
			? { ...b, toolCalls: [...b.toolCalls, { name }] }
			: b,
	)
}

/**
 * Stamp the most-recent matching tool entry on a subagent block with its
 * success/failure verdict. Server emits `tool_call` followed by `tool_result`,
 * so the LAST entry with the matching name is the one that just finished.
 */
export function applySubagentToolResult(
	blocks: StreamingBlock[],
	target: SubagentTargetMatch,
	name: string,
	success: boolean,
): StreamingBlock[] {
	return blocks.map((b) => {
		if (b.kind !== 'subagent' || b.agentId !== target.agentId || b.conversationId !== target.conversationId) {
			return b
		}
		const updatedTools = b.toolCalls.map((tc, i) =>
			i === b.toolCalls.length - 1 && tc.name === name ? { ...tc, success } : tc,
		)
		return { ...b, toolCalls: updatedTools }
	})
}

/** Mark the matching subagent block completed and collapse it. */
export function applySubagentDone(
	blocks: StreamingBlock[],
	target: SubagentTargetMatch,
): StreamingBlock[] {
	return blocks.map((b) =>
		b.kind === 'subagent' &&
		b.agentId === target.agentId &&
		b.conversationId === target.conversationId
			? { ...b, status: 'completed' as const, expanded: false }
			: b,
	)
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

// ─────────── Block mutators (pure transforms used by SSE event handling) ───────────
//
// These take the current state and return the next state. The chat page binds them
// against its $state declarations; pulling them out of the page makes the streaming
// state machine independently inspectable + testable.

function newId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Append reasoning content to the last thinking block (or create a new one). Returns
 * the next blocks array AND the next target string (the page tracks the target
 * separately so the typewriter interpolator knows where to stop).
 *
 * If the last thinking block was collapsed, re-expands it — a fresh stream of
 * reasoning means the operator should see it again.
 */
export function appendThinking(
	blocks: StreamingBlock[],
	target: string,
	content: string,
): { blocks: StreamingBlock[]; target: string } {
	if (!content) return { blocks, target }
	const lastIdx = blocks.length - 1
	const lastBlock = blocks[lastIdx]
	if (lastBlock?.kind === 'thinking') {
		const nextBlocks = lastBlock.expanded
			? blocks
			: blocks.map((b, i) =>
					i === lastIdx && b.kind === 'thinking' ? { ...b, expanded: true } : b,
				)
		return { blocks: nextBlocks, target: target + content }
	}
	return {
		blocks: [
			...blocks,
			{
				kind: 'thinking' as const,
				id: newId('thinking'),
				content: '',
				reasoningTokens: null,
				expanded: true,
			},
		],
		target: content,
	}
}

/** Stamp the latest thinking block with its final reasoning-token count. */
export function setLatestReasoningTokens(
	blocks: StreamingBlock[],
	reasoningTokens: number | null | undefined,
): StreamingBlock[] {
	if (typeof reasoningTokens !== 'number' || reasoningTokens <= 0) return blocks
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (blocks[i].kind !== 'thinking') continue
		return blocks.map((entry, idx) =>
			idx === i && entry.kind === 'thinking' ? { ...entry, reasoningTokens } : entry,
		)
	}
	return blocks
}

/** Commit `target` into the last text block as its final content. */
export function finalizeText(blocks: StreamingBlock[], target: string): StreamingBlock[] {
	if (!target) return blocks
	const lastIdx = blocks.length - 1
	if (lastIdx < 0 || blocks[lastIdx].kind !== 'text') return blocks
	return blocks.map((b, i) =>
		i === lastIdx && b.kind === 'text' ? { ...b, content: target } : b,
	)
}

/** Commit `target` into the last thinking block as its final content. */
export function finalizeThinking(blocks: StreamingBlock[], target: string): StreamingBlock[] {
	if (!target) return blocks
	const lastIdx = blocks.length - 1
	if (lastIdx < 0 || blocks[lastIdx].kind !== 'thinking') return blocks
	return blocks.map((b, i) =>
		i === lastIdx && b.kind === 'thinking' ? { ...b, content: target } : b,
	)
}

/**
 * `delta` event — the model started emitting text content. Collapses any expanded
 * tool blocks so the new text gets visual focus, and appends an empty text block
 * if the previous block wasn't already text. Returns blocks unchanged when text
 * was already in flight.
 */
export function applyDeltaStart(blocks: StreamingBlock[]): StreamingBlock[] {
	const lastBlock = blocks.at(-1)
	if (lastBlock && lastBlock.kind === 'text') return blocks
	return [
		...blocks.map((b) => (b.kind === 'tool' ? { ...b, expanded: false } : b)),
		{ kind: 'text' as const, id: newId('txt'), content: '' },
	]
}

/** `tool_pending` event — operator approval required. Appends a pending tool block. */
export function applyToolPending(
	blocks: StreamingBlock[],
	payload: { id: string; name: string; arguments?: string; token?: string },
): StreamingBlock[] {
	return [
		...blocks.map((b) =>
			b.kind === 'tool' || b.kind === 'thinking' ? { ...b, expanded: false } : b,
		),
		{
			kind: 'tool' as const,
			id: payload.id,
			name: payload.name,
			arguments: payload.arguments ?? '',
			status: 'pending' as const,
			expanded: true,
			token: payload.token,
		},
	]
}

/**
 * `tool_call` event — execution starting. Two paths:
 *   1. We already have a pending block for this id (approved → executing): just
 *      flip status and collapse other tool/thinking blocks.
 *   2. No pending block (auto-approve mode skips the pending phase): append a
 *      fresh executing block.
 */
export function applyToolCall(
	blocks: StreamingBlock[],
	payload: { id: string; name: string; arguments?: string },
): StreamingBlock[] {
	const existing = blocks.some((b) => b.kind === 'tool' && b.id === payload.id)
	if (existing) {
		return blocks.map((b) =>
			b.kind === 'tool' && b.id === payload.id
				? { ...b, status: 'executing' as const, expanded: true }
				: b.kind === 'tool'
					? { ...b, expanded: false }
					: b.kind === 'thinking'
						? { ...b, expanded: false }
						: b,
		)
	}
	return [
		...blocks.map((b) =>
			b.kind === 'tool' || b.kind === 'thinking' ? { ...b, expanded: false } : b,
		),
		{
			kind: 'tool' as const,
			id: payload.id,
			name: payload.name,
			arguments: payload.arguments ?? '',
			status: 'executing' as const,
			expanded: true,
			token: null,
		},
	]
}

/**
 * `tool_result` event — execution finished. If we have the matching tool block
 * we update its status + result + executionMs in-place; otherwise we append a
 * synthetic completed block (better than dropping the result silently).
 *
 * Returns `{ blocks, missing }` so the caller can warn in its log when the
 * server emitted a result without a matching call (suggests a state-machine bug).
 */
export function applyToolResult(
	blocks: StreamingBlock[],
	payload: {
		id: string
		name?: string
		success?: boolean
		executionMs?: number | null
		result?: string
	},
): { blocks: StreamingBlock[]; missing: boolean; unexpectedStatus: ToolStatus | null } {
	const finalStatus = payload.success ? ('completed' as const) : ('failed' as const)
	const resultText = payload.result ?? (payload.success ? 'Success' : 'Tool execution failed')
	const idx = blocks.findIndex((b) => b.kind === 'tool' && b.id === payload.id)
	if (idx === -1) {
		return {
			missing: true,
			unexpectedStatus: null,
			blocks: [
				...blocks.map((b) =>
					b.kind === 'tool' || b.kind === 'thinking' ? { ...b, expanded: false } : b,
				),
				{
					kind: 'tool' as const,
					id: payload.id,
					name: payload.name ?? 'unknown',
					arguments: '',
					status: finalStatus,
					expanded: true,
					token: null,
					executionMs: payload.executionMs ?? null,
					result: resultText,
				},
			],
		}
	}
	const existing = blocks[idx]
	const unexpected =
		existing.kind === 'tool' &&
		existing.status !== 'executing' &&
		existing.status !== 'approved'
	return {
		missing: false,
		unexpectedStatus: unexpected ? (existing as ToolBlock).status : null,
		blocks: blocks.map((b, i) =>
			i === idx && b.kind === 'tool'
				? {
						...b,
						status: finalStatus,
						executionMs: payload.executionMs ?? null,
						result: resultText,
					}
				: b,
		),
	}
}

/**
 * `ask_user` event — append a synthetic executing tool block carrying the
 * questions so the AskUserCard can render inline. Skips the append when a tool
 * block with the same id already exists (idempotent re-emit).
 */
export function applyAskUser(
	blocks: StreamingBlock[],
	payload: { id: string; name?: string; token?: string | null; questions?: unknown },
): StreamingBlock[] {
	const collapsed = blocks.map((b) => (b.kind === 'thinking' ? { ...b, expanded: false } : b))
	if (!payload.id) return collapsed
	const existing = collapsed.find((b) => b.kind === 'tool' && b.id === payload.id)
	if (existing) return collapsed
	const askUserArgs = JSON.stringify({ questions: payload.questions ?? [] })
	return [
		...collapsed.map((b) => (b.kind === 'tool' ? { ...b, expanded: false } : b)),
		{
			kind: 'tool' as const,
			id: payload.id,
			name: payload.name ?? 'ask_user',
			arguments: askUserArgs,
			status: 'executing' as const,
			expanded: true,
			token: payload.token ?? null,
		},
	]
}
