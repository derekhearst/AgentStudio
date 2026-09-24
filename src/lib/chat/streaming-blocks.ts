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
import {
	appendStreamTail,
	type BackgroundShellStatus,
	type ToolResultDetails,
} from '../engine/tool-result-details'
import type { RunNotice } from '../engine/sdk-notices'

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
	/**
	 * Seconds this call has been running, from the SDK's `tool_progress` heartbeats. Those
	 * carry no partial output, so this is what makes the spinner honest — it says "still
	 * going, 40s in" rather than just spinning.
	 */
	elapsedSeconds?: number | null
	/**
	 * Typed output for the built-ins worth rendering specially — diff, terminal, todo list.
	 * Rides the `tool_result` frame; absent for every other tool, which is what keeps the
	 * generic card the default rather than a fallback.
	 */
	details?: ToolResultDetails
	/** Characters of a background command's output received live (#35) — see `applyShellOutput`. */
	shellStreamed?: number
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

export type NoticeBlock = {
	kind: 'notice'
	id: string
	notice: RunNotice
}

export type StreamingBlock = TextBlock | ToolBlock | ThinkingBlock | SubagentBlock | NoticeBlock

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
 * A block saved from the page is saved because its turn is over (Stop, an error, a lost
 * stream), and a background command does not outlive its turn (#35). One still marked
 * running would read as running forever in the saved transcript.
 */
function settledDetails(details: ToolResultDetails): ToolResultDetails {
	if (details.kind !== 'shell' || details.background?.status !== 'running') return details
	return { ...details, background: { status: 'ended_with_turn' } }
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
		} else if (block.kind === 'notice') {
			/*
			 * Every notice is shown live, but only the durable ones belong in the transcript —
			 * the same decision the engine makes when it builds its own blocks. Without this
			 * test a turn the user stopped would persist its API retries, because this path
			 * (the client's partial save) is the one that runs when no `done` arrives.
			 */
			if (block.notice.persist) out.push({ kind: 'notice', notice: block.notice })
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
				// Persisted so a reloaded conversation renders the same diff / terminal / todo
				// card as the live stream did, rather than degrading to the generic one.
				...(block.details ? { details: settledDetails(block.details) } : {}),
			})
		}
	}
	return out
}

/**
 * Persisted shape of a completed tool call — what gets serialized to
 * `messages.toolCalls` jsonb after a stream finishes. The fields are a subset of
 * `ToolBlock` (the live shape includes lifecycle state we don't store).
 *
 * `arguments` is parsed from the streamed JSON string back into an object so
 * downstream renderers don't have to re-parse on every render. `result` is kept
 * as a string because it can be either JSON or a plain message and the renderer
 * decides per-tool.
 */
export type PersistedToolCall = {
	name: string
	arguments: Record<string, unknown>
	result: string
	status: 'completed' | 'failed' | 'denied'
}

/** Tool blocks whose lifecycle has reached a terminal state, normalized for callers that need a flat list. */
export function getCompletedToolCalls(blocks: StreamingBlock[]): PersistedToolCall[] {
	return blocks
		.filter(
			(b): b is ToolBlock =>
				b.kind === 'tool' && (b.status === 'completed' || b.status === 'failed' || b.status === 'denied'),
		)
		.map((b) => ({
			name: b.name,
			arguments: parseJsonFallback(b.arguments),
			result: b.result ?? '',
			status: b.status as PersistedToolCall['status'],
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
	toolCalls?: PersistedToolCall[] | Array<Record<string, unknown>>
}

/**
 * The fields the chat domain writes into / reads from the `messages.metadata`
 * jsonb column. The column itself stays opaque at the DB layer — anything the
 * runtime wants to stash (offload handles, future debug fields) flows through
 * without a schema change. This type just names the keys our own code
 * actively touches so callers stop reaching into `Record<string, unknown>`.
 */
export type ChatMessageMetadata = {
	/** Per-block stream snapshot, persisted so reload re-renders the same shape. */
	blocks?: StreamingBlock[]
	/** Anthropic / OpenAI reasoning-token count if the run produced reasoning. */
	reasoningTokens?: number
	/** True when the assistant message was committed mid-stream (interrupt / error). */
	partial?: boolean
	/** Run id that produced this message — used to merge partials into finals. */
	runId?: string
	/** Reasoning effort the user picked at send time. */
	reasoningEffort?: string
	/** True when the user clicked Stop. */
	stoppedByUser?: boolean
	/** Anthropic prompt-cache write/read deltas, when available. */
	tokensCacheWrite?: number
	tokensCacheRead?: number
	/** Routing decision metadata (model selection, cost). */
	modelSelection?: Record<string, unknown>
	/** Allow-through for fields we don't model yet. */
	[key: string]: unknown
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
/**
 * `notice` frame — append a run-level notice to the transcript.
 *
 * Appended rather than folded into the current text block: a compaction boundary or a
 * permission refusal is not something the assistant said, and reading it as if it were
 * would be worse than not showing it.
 */
export function applyNotice(blocks: StreamingBlock[], notice: RunNotice, id: string): StreamingBlock[] {
	return [
		...blocks.map((b) => (b.kind === 'thinking' || b.kind === 'tool' ? { ...b, expanded: false } : b)),
		{ kind: 'notice' as const, id, notice },
	]
}

/**
 * `tool_progress` frame — record how long an in-flight call has been running.
 *
 * A heartbeat for a call that already finished is ignored rather than resurrecting it: the
 * frames race with `tool_result`, and a completed card must not start counting again.
 */
export function applyToolProgress(
	blocks: StreamingBlock[],
	payload: { id: string; elapsedSeconds: number },
): StreamingBlock[] {
	return blocks.map((b) =>
		b.kind === 'tool' && b.id === payload.id && (b.status === 'executing' || b.status === 'approved')
			? { ...b, elapsedSeconds: payload.elapsedSeconds }
			: b,
	)
}

/**
 * `shell_output` frame (#35) — new output from a backgrounded command, added to its card.
 *
 * Capped to the same tail the server keeps (`appendStreamTail`), so the live card and the
 * persisted block agree. `reset` replaces instead of adding: the first read of the output
 * file, a truncated file, or a jump ahead to the newest output. A chunk that does not start
 * where the card left off (a page that reconnected mid-turn missed the frames in between —
 * they are live-only) marks the output as a tail, so the card says earlier output is missing
 * rather than passing a fragment off as the whole thing.
 */
export function applyShellOutput(
	blocks: StreamingBlock[],
	payload: { id: string; chunk?: string; reset?: boolean; truncated?: boolean; from?: number; to?: number },
): StreamingBlock[] {
	const chunk = typeof payload.chunk === 'string' ? payload.chunk : ''
	return blocks.map((b) => {
		if (b.kind !== 'tool' || b.id !== payload.id || b.details?.kind !== 'shell') return b
		// Already settled: `shell_task_done` carried the final output, and nothing comes after it.
		if (b.details.background && b.details.background.status !== 'running') return b
		const reset = payload.reset === true
		const next = appendStreamTail(reset ? '' : b.details.stdout, chunk)
		const gap = !reset && typeof payload.from === 'number' && payload.from !== (b.shellStreamed ?? 0)
		return {
			...b,
			shellStreamed: typeof payload.to === 'number' ? payload.to : (b.shellStreamed ?? 0) + chunk.length,
			details: {
				...b.details,
				stdout: next.text,
				truncated: next.truncated || gap || payload.truncated === true || (!reset && b.details.truncated),
				background: { status: 'running' as const },
			},
		}
	})
}

/**
 * `shell_task_done` frame (#35) — a background command finished, was stopped, or its turn
 * ended. Carries the final output, which replaces whatever the live frames built up: it is
 * what the server persisted, so the card now matches the saved transcript exactly.
 */
export function applyShellTaskDone(
	blocks: StreamingBlock[],
	payload: {
		id: string
		status?: BackgroundShellStatus
		exitCode?: number | null
		stdout?: string
		truncated?: boolean
	},
): StreamingBlock[] {
	const status = payload.status
	if (status !== 'completed' && status !== 'failed' && status !== 'stopped' && status !== 'ended_with_turn') {
		return blocks
	}
	return blocks.map((b) => {
		if (b.kind !== 'tool' || b.id !== payload.id || b.details?.kind !== 'shell') return b
		return {
			...b,
			details: {
				...b.details,
				...(typeof payload.stdout === 'string' ? { stdout: payload.stdout, truncated: payload.truncated === true } : {}),
				...(typeof payload.exitCode === 'number' ? { exitCode: payload.exitCode } : {}),
				background: { status },
			},
		}
	})
}

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
		/**
		 * This bubble is local-only: the send is in flight and nothing is persisted
		 * yet. The UI dims it so a message that never lands is visibly distinct
		 * from one that did, rather than looking identical to a saved message.
		 */
		optimistic: true as const,
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
		details?: ToolResultDetails
	},
): { blocks: StreamingBlock[]; missing: boolean; unexpectedStatus: ToolStatus | null } {
	const finalStatus = payload.success ? ('completed' as const) : ('failed' as const)
	const resultText = payload.result ?? (payload.success ? 'Success' : 'Tool execution failed')
	/*
	 * #81 — an ask_user card is keyed by the host's answer token (the `ask_user` frame) and
	 * its result by the SDK's tool_use id, so the two never met: the card stayed open with its
	 * Submit button and an empty block was appended instead. The result belongs to the oldest
	 * card still waiting for one — a card whose id is still its token — and the card takes the
	 * SDK's id with it, so a replayed result finds it directly.
	 */
	const askUserCard =
		payload.name === 'ask_user' && !blocks.some((b) => b.kind === 'tool' && b.id === payload.id)
			? blocks.findIndex((b) => b.kind === 'tool' && b.name === 'ask_user' && !!b.token && b.id === b.token)
			: -1
	const idx = askUserCard !== -1 ? askUserCard : blocks.findIndex((b) => b.kind === 'tool' && b.id === payload.id)
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
					...(payload.details ? { details: payload.details } : {}),
				},
			],
		}
	}
	const existing = blocks[idx]
	// An answered ask_user card is already marked completed by `applyAskUserAnswered`.
	const unexpected =
		askUserCard === -1 &&
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
						...(i === askUserCard ? { id: payload.id } : {}),
						status: finalStatus,
						executionMs: payload.executionMs ?? null,
						result: resultText,
						...(payload.details ? { details: payload.details } : {}),
					}
				: b,
		),
	}
}

/**
 * The server recorded the user's answers to an ask_user card (#81): show it answered now,
 * rather than with its Submit button still live until the call's `tool_result` arrives. The
 * card keeps its token as its id, so that result still finds it (`applyToolResult`).
 */
export function applyAskUserAnswered(
	blocks: StreamingBlock[],
	token: string,
	answers: Record<string, string>,
): StreamingBlock[] {
	return blocks.map((b) =>
		b.kind === 'tool' && b.name === 'ask_user' && b.token === token
			? { ...b, status: 'completed' as const, result: JSON.stringify({ answers }) }
			: b,
	)
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
