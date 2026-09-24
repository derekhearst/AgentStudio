/**
 * The engine's side of a delegated child's card (#32): how its persisted `subagent` block
 * is opened, filled and closed as the child's messages arrive.
 *
 * `./stream.server` routes a child's messages by `parent_tool_use_id` and calls these; the
 * decisions live here so they can be read, and tested, without driving the whole loop.
 *
 * ## One card per delegation
 *
 * The card opens at the parent's `Agent` call, not at the child's first message, so a child
 * that is refused (the cap, the budget, plan mode) or fails before saying anything still has
 * a card that says so. The delegation itself gets no `tool` block and no `tool_call` frame:
 * the card is its representation, and the chat used to show both a generic tool card and
 * the child card for one delegation — the child's report twice.
 *
 * ## Closing
 *
 * The delegation's own tool result closes the card, carrying the SDK's typed `AgentOutput`
 * (`SubagentDetails`). A background launch placeholder (`async_launched`) does not close it —
 * that child is still working — though the delegation gate forces foreground, so this is the
 * defensive path. A card still open when the turn ends was cut short (Stop interrupts the
 * turn, and the CLI takes its foreground children down with it) and is closed as `stopped`,
 * so no card spins forever after a reload.
 *
 * Pure: types from the schema, helpers from the pure transcript module.
 */

import type { StreamBlock, SubagentRunStatus } from '../runs/runs.schema'
import type { SubagentDetails, ToolResultDetails } from './tool-result-details'
import {
	appendTranscriptText,
	appendTranscriptToolCall,
	settleTranscriptToolCall,
	toolCallLabel,
	type SubagentTranscript,
} from './subagent-transcript'

export type EngineSubagentBlock = Extract<StreamBlock, { kind: 'subagent' }>

/** Characters of a refusal or failure message kept on the card. */
const MAX_ERROR_CHARS = 1_000

/** The `subagent_done` frame: which child, how it ended, and what it reported. */
export type SubagentDonePayload = {
	agentId: string
	conversationId: null
	success: boolean
	status: Exclude<SubagentRunStatus, 'running'>
	details?: SubagentDetails
	error?: string | null
}

/** A fresh card for the delegation `toolUseId`. */
export function openSubagentBlock(
	toolUseId: string,
	meta: { agentName: string; task: string },
): EngineSubagentBlock {
	return {
		kind: 'subagent',
		agentId: toolUseId,
		agentName: meta.agentName,
		// SDK subagents have no child conversation row to link to.
		conversationId: null,
		task: meta.task,
		content: '',
		success: true,
		status: 'running',
		transcript: [],
	}
}

function update(block: EngineSubagentBlock, change: (t: SubagentTranscript) => SubagentTranscript): void {
	const next = change({ entries: block.transcript ?? [], truncated: block.transcriptTruncated === true })
	block.transcript = next.entries
	if (next.truncated) block.transcriptTruncated = true
}

/** Something the child said. `content` keeps the plain concatenation older readers expect. */
export function recordChildText(block: EngineSubagentBlock, text: string): void {
	if (!text) return
	block.content += text
	update(block, (t) => appendTranscriptText(t, text))
}

/** A tool call the child made. Returns the label, for the frame. */
export function recordChildToolCall(block: EngineSubagentBlock, name: string, input: unknown): string | null {
	const label = toolCallLabel(input)
	update(block, (t) => appendTranscriptToolCall(t, name, label))
	return label
}

/** One of the child's calls finished. A failed call marks the child failed, as it always has. */
export function recordChildToolResult(block: EngineSubagentBlock, name: string, success: boolean): void {
	if (!success) block.success = false
	update(block, (t) => settleTranscriptToolCall(t, name, success))
}

/**
 * The delegation's own tool result arrived. Returns the `subagent_done` payload, or null
 * when the result is a launch placeholder and the child is still running.
 */
export function finishSubagentBlock(
	block: EngineSubagentBlock,
	result: { isError: boolean; text: string; details?: ToolResultDetails | null },
): SubagentDonePayload | null {
	const details = result.details?.kind === 'subagent' ? result.details : undefined
	if (details) block.details = details

	if (!result.isError && details && details.status !== 'completed') return null

	// The delegation's own result decides. A child that had one call fail and then finished its
	// task anyway completed; the failed call stays visible in its transcript.
	const success = !result.isError
	const status: SubagentDonePayload['status'] = success ? 'completed' : 'failed'
	block.status = status
	block.success = success
	if (result.isError) {
		const error = result.text.trim().slice(0, MAX_ERROR_CHARS) || 'The delegated agent failed.'
		block.error = error
	}
	return {
		agentId: block.agentId,
		conversationId: null,
		success,
		status,
		...(details ? { details } : {}),
		...(block.error ? { error: block.error } : {}),
	}
}

/**
 * Close every card still running when the turn ended. Returns the frames to send, so the
 * live page closes the same cards the persisted transcript does.
 */
export function stopUnfinishedSubagents(blocks: Iterable<EngineSubagentBlock>): SubagentDonePayload[] {
	const stopped: SubagentDonePayload[] = []
	for (const block of blocks) {
		if (block.status !== 'running') continue
		block.status = 'stopped'
		block.success = false
		block.error = block.error ?? 'Stopped before it finished.'
		stopped.push({
			agentId: block.agentId,
			conversationId: null,
			success: false,
			status: 'stopped',
			error: block.error,
		})
	}
	return stopped
}
