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

export type ArtifactCardData = {
	artifactId: string
	name: string
	contentType: 'markdown' | 'code' | 'json' | 'yaml' | 'plaintext'
	versionSeq: number
	content: string
	focus: 'plan' | 'todo' | 'document' | 'data' | null
	note: string | null
}

/**
 * Parse the result payload from a completed `present_artifact` tool call. The executor
 * loads the artifact's current version content and ships it back so the chat UI can render
 * an inline ArtifactCard without an extra fetch.
 */
export function getArtifactCardFromTool(block: ToolBlockLike): ArtifactCardData | null {
	if (!block.result) return null
	const result = parseJsonFallback(block.result)
	const artifactId = typeof result.artifactId === 'string' ? result.artifactId : null
	const name = typeof result.name === 'string' ? result.name : null
	const content = typeof result.content === 'string' ? result.content : null
	const versionSeq = typeof result.versionSeq === 'number' ? result.versionSeq : null
	if (!artifactId || !name || content === null || versionSeq === null) return null
	const contentTypeRaw = typeof result.contentType === 'string' ? result.contentType : 'markdown'
	const contentType: ArtifactCardData['contentType'] =
		contentTypeRaw === 'code' || contentTypeRaw === 'json' || contentTypeRaw === 'yaml' || contentTypeRaw === 'plaintext'
			? contentTypeRaw
			: 'markdown'
	const focus =
		result.focus === 'plan' || result.focus === 'todo' || result.focus === 'document' || result.focus === 'data'
			? result.focus
			: null
	const note = typeof result.note === 'string' && result.note.trim().length > 0 ? result.note : null
	return { artifactId, name, contentType, versionSeq, content, focus, note }
}

export function getAskUserAnswersFromTool(block: ToolBlockLike): Record<string, string> | null {
	if (!block.result) return null
	const result = parseJsonFallback(block.result)
	if (!result || typeof result !== 'object') return null
	const answers = result.answers
	if (!answers || typeof answers !== 'object') return null
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(answers as Record<string, unknown>)) {
		if (typeof v === 'string') out[k] = v
	}
	return Object.keys(out).length > 0 ? out : null
}
