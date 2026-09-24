/**
 * Pure parsers for tool-block payloads emitted on the chat stream.
 *
 * The chat page persists each tool call as a JSON blob (`arguments` going in,
 * `result` coming out). These helpers shape that raw payload into the
 * structured forms the UI cards expect, with permissive fallbacks so a
 * partially-formed block still renders something useful.
 *
 * Relative imports only: `./message-bubble-helpers` imports this, and specs load both in the
 * plain Playwright loader, where the SvelteKit alias is not guaranteed to resolve.
 */

// Re-export so call sites that already import `parseJsonFallback` keep working;
// the shared implementation lives in `$lib/util/json` (parseJsonRecord — also
// guards against non-object JSON values like null or arrays).
import { parseJsonRecord as parseJsonFallback } from '../util/json'
import { readAskUserAnswers } from './ask-user-answers'
import {
	LEGACY_ASK_USER_TOOL,
	answerKey,
	isAskUserToolName,
	readAskQuestions,
	type AskOption,
	type AskQuestion,
} from '../engine/ask-user-question'
export { parseJsonFallback }

/**
 * A question card's question: the SDK's AskUserQuestion (#4) or a retired `ask_user` one.
 * Both read into one shape — see `$lib/engine/ask-user-question`.
 */
export type AskUserOption = AskOption
export type AskUserQuestion = AskQuestion
export { isAskUserToolName }

type ToolBlockLike = {
	/** `AskUserQuestion`, or `ask_user` for a block from before #4. Absent reads as the latter. */
	name?: string
	arguments: string
	result?: string | null
	/** The call's distilled result; an AskUserQuestion's carries its answers. */
	details?: unknown
}

function isLegacyBlock(block: ToolBlockLike): boolean {
	return block.name === undefined || block.name === LEGACY_ASK_USER_TOOL
}

export function getAskUserQuestionsFromTool(block: ToolBlockLike): AskUserQuestion[] {
	const args = parseJsonFallback(block.arguments)
	const result = block.result ? parseJsonFallback(block.result) : {}
	const fromArgs = Array.isArray(args.questions) ? args.questions : []
	const fromResult = Array.isArray(result.questions) ? result.questions : []
	const source = fromArgs.length > 0 ? fromArgs : fromResult
	return readAskQuestions(source, { legacy: isLegacyBlock(block) })
}

/** The answers on an AskUserQuestion block's distilled result, keyed by question text. */
function detailsAnswers(details: unknown): Record<string, string> | null {
	const record = details && typeof details === 'object' ? (details as { kind?: unknown; answers?: unknown }) : null
	if (record?.kind !== 'ask_user_question' || !record.answers || typeof record.answers !== 'object') return null
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(record.answers as Record<string, unknown>)) {
		if (typeof value === 'string' && value.trim()) out[key] = value
	}
	return Object.keys(out).length > 0 ? out : null
}

/**
 * The answers recorded on a question block, keyed like its questions (`answerKey`), or null
 * while it has none. An AskUserQuestion block carries them on its `details` once the call's
 * result is in; before that — the moment the server records them — as a JSON `{ answers }`
 * result. A retired `ask_user` block also reads the host's `Header: answer` text; see
 * `./ask-user-answers`.
 */
export function getAskUserAnswersFromTool(block: ToolBlockLike): Record<string, string> | null {
	const fromDetails = detailsAnswers(block.details)
	if (fromDetails) return fromDetails
	if (!block.result) return null
	const keys = getAskUserQuestionsFromTool(block).map((question) => answerKey(question))
	return readAskUserAnswers(block.result, keys)
}
