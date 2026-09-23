/**
 * Pure parsers for tool-block payloads emitted on the chat stream.
 *
 * The chat page persists each tool call as a JSON blob (`arguments` going in,
 * `result` coming out). These helpers shape that raw payload into the
 * structured forms the UI cards expect, with permissive fallbacks so a
 * partially-formed block still renders something useful.
 */

export type AskUserOption = {
	label: string
	description?: string
	recommended?: boolean
}

export type AskUserQuestion = {
	header: string
	question: string
	options: AskUserOption[]
	allowFreeformInput?: boolean
}

type ToolBlockLike = {
	arguments: string
	result?: string | null
}

// Re-export so call sites that already import `parseJsonFallback` keep working;
// the shared implementation lives in `$lib/util/json` (parseJsonRecord — also
// guards against non-object JSON values like null or arrays).
import { parseJsonRecord as parseJsonFallback } from '$lib/util/json'
import { readAskUserAnswers } from './ask-user-answers'
export { parseJsonFallback }

export function getAskUserQuestionsFromTool(block: ToolBlockLike): AskUserQuestion[] {
	const args = parseJsonFallback(block.arguments)
	const result = block.result ? parseJsonFallback(block.result) : {}
	const fromArgs = Array.isArray(args.questions) ? args.questions : []
	const fromResult = Array.isArray(result.questions) ? result.questions : []
	const source = fromArgs.length > 0 ? fromArgs : fromResult

	return source
		.map((entry) => {
			const row = (entry ?? {}) as Record<string, unknown>
			const header = typeof row.header === 'string' ? row.header : ''
			const question = typeof row.question === 'string' ? row.question : header
			const options = Array.isArray(row.options)
				? (row.options as Array<Record<string, unknown>>)
						.map((opt) => ({
							label: typeof opt.label === 'string' ? opt.label : '',
							description: typeof opt.description === 'string' ? opt.description : undefined,
							recommended: typeof opt.recommended === 'boolean' ? opt.recommended : undefined,
						}))
						.filter((opt) => opt.label.length > 0)
				: []
			const allowFreeformInput =
				typeof row.allowFreeformInput === 'boolean' ? row.allowFreeformInput : true
			return { header, question, options, allowFreeformInput }
		})
		.filter((row) => row.question.trim().length > 0)
}

/**
 * The answers recorded on an ask_user block's result, or null while it has none. Reads the
 * host's `Header: answer` text as well as a JSON `{ answers }` object — see `./ask-user-answers`.
 */
export function getAskUserAnswersFromTool(block: ToolBlockLike): Record<string, string> | null {
	if (!block.result) return null
	const headers = getAskUserQuestionsFromTool(block).map((question) => question.header)
	return readAskUserAnswers(block.result, headers)
}
