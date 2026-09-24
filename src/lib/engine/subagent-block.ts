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
 * (`SubagentDetails`).
 *
 * Stop closes it as `stopped`, not `failed`. When the turn is interrupted, the CLI answers
 * every delegation still running before the turn's `result` arrives, with an error result of
 * its own making: `[Request interrupted by user for tool use]`, or a synthetic cancellation
 * (read in the bundled CLI 2.1.278, `StreamingToolExecutor.createSyntheticErrorMessage`).
 * Taken at face value, that would close the card as `failed`, in red, with the CLI's wording
 * as the reason. So an error result that arrives after the engine has sent the interrupt, or
 * that carries the CLI's interrupt text, closes the card as `stopped`.
 *
 * A background launch placeholder (`async_launched`, `remote_launched`) does not close the
 * card: that child is still working. The delegation gate forces the foreground, but an agent
 * definition can still ask for the background (a trusted project's `background: true`), and
 * the CLI honours that over the call's own `run_in_background: false`. Such a card closes on
 * the child's `task_notification`, which says how it ended (`closeBackgroundedSubagent`). Its
 * concurrency slot is held until then (`./stream.server`).
 *
 * A card still open when the turn ends was cut short and is closed as `stopped`, so no card
 * spins forever after a reload.
 *
 * Every frame that closes a card carries what the child spent, added up over its model calls
 * (`./subagent-usage`), so the card's figures and the child's ledger row agree.
 *
 * Pure: types from the schema, helpers from the pure transcript module.
 */

import type { StreamBlock, SubagentRunStatus } from '../runs/runs.schema'
import type { SubagentDetails, ToolResultDetails } from './tool-result-details'
import type { SubagentSpend } from './subagent-usage'
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

/** What a stopped card says, whichever way the stop reached it. */
export const STOPPED_REASON = 'Stopped before it finished.'

/**
 * Whether an error result is the CLI's own answer for a call cut short by an interrupt,
 * rather than anything the child did. This is the CLI's wording, read in 2.1.278. The
 * engine's own record of having sent the interrupt covers the synthetic variants, which are
 * worded differently.
 */
export function isInterruptResult(text: string): boolean {
	return text.trimStart().startsWith('[Request interrupted by user')
}

/** The `subagent_done` frame: which child, how it ended, what it reported and spent. */
export type SubagentDonePayload = {
	agentId: string
	conversationId: null
	success: boolean
	status: Exclude<SubagentRunStatus, 'running'>
	details?: SubagentDetails
	error?: string | null
	/** What the child spent, added up over its model calls (`./subagent-usage`). */
	usage?: SubagentSpend
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

/** The child's spend so far (`./subagent-usage`). Nothing to record keeps what is there. */
export function recordChildSpend(block: EngineSubagentBlock, spend: SubagentSpend | null): void {
	if (spend) block.usage = spend
}

/** The frame for a card that has just closed. */
function donePayload(block: EngineSubagentBlock): SubagentDonePayload {
	const status: SubagentDonePayload['status'] =
		block.status === 'failed' || block.status === 'stopped' ? block.status : 'completed'
	return {
		agentId: block.agentId,
		conversationId: null,
		success: block.success,
		status,
		...(block.details ? { details: block.details } : {}),
		...(block.error ? { error: block.error } : {}),
		...(block.usage ? { usage: block.usage } : {}),
	}
}

/**
 * The delegation's own tool result arrived. Returns the `subagent_done` payload, or null
 * when the result is a launch placeholder and the child is still running.
 *
 * `interrupted` is whether the engine has sent the turn an interrupt (Stop). An error result
 * after that is the CLI cutting the child short, and closes the card as `stopped`.
 */
export function finishSubagentBlock(
	block: EngineSubagentBlock,
	result: { isError: boolean; text: string; details?: ToolResultDetails | null; interrupted?: boolean },
): SubagentDonePayload | null {
	const details = result.details?.kind === 'subagent' ? result.details : undefined
	if (details) block.details = details

	if (!result.isError && details && details.status !== 'completed') return null

	if (result.isError && (result.interrupted === true || isInterruptResult(result.text))) {
		block.status = 'stopped'
		block.success = false
		block.error = STOPPED_REASON
		return donePayload(block)
	}

	// The delegation's own result decides. A child that had one call fail and then finished its
	// task anyway completed; the failed call stays visible in its transcript.
	const success = !result.isError
	block.status = success ? 'completed' : 'failed'
	block.success = success
	if (result.isError) {
		block.error = result.text.trim().slice(0, MAX_ERROR_CHARS) || 'The delegated agent failed.'
	}
	return donePayload(block)
}

/** How a background task ended, as its `task_notification` says. */
export type TaskNotificationOutcome = {
	status: 'completed' | 'failed' | 'stopped'
	summary?: string | null
}

/** Whether the card is waiting on a child the CLI sent to the background. */
export function isBackgroundedSubagent(block: EngineSubagentBlock): boolean {
	const launch = block.details?.status
	return block.status === 'running' && (launch === 'async_launched' || launch === 'remote_launched')
}

/**
 * A backgrounded child's `task_notification` arrived: close its card the way the
 * notification says it ended. Returns null for a card that is not waiting on one. A
 * foreground child's own result closes its card with the full typed result, and the
 * notification the CLI also sends for it adds nothing.
 */
export function closeBackgroundedSubagent(
	block: EngineSubagentBlock,
	outcome: TaskNotificationOutcome,
): SubagentDonePayload | null {
	if (!isBackgroundedSubagent(block)) return null
	const summary = (outcome.summary ?? '').trim().slice(0, MAX_ERROR_CHARS)
	if (outcome.status === 'completed') {
		block.status = 'completed'
		block.success = true
		// The report never came back through the tool call; the summary is what there is.
		if (summary && !block.content.trim()) recordChildText(block, summary)
	} else if (outcome.status === 'stopped') {
		block.status = 'stopped'
		block.success = false
		block.error = summary || STOPPED_REASON
	} else {
		block.status = 'failed'
		block.success = false
		block.error = summary || 'The delegated agent failed.'
	}
	return donePayload(block)
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
		block.error = block.error ?? STOPPED_REASON
		stopped.push(donePayload(block))
	}
	return stopped
}
