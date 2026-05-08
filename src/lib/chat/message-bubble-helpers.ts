/**
 * Pure helpers for the MessageBubble component.
 *
 * Decode JSONB-or-string blobs from the messages table, gate empty saved
 * blocks out of the render, extract ask_user / artifact metadata for inline
 * cards, and normalize text for the dedupe check that suppresses the model's
 * inline question when the same prompt is already in an ask_user card.
 *
 * Pure functions only — every helper takes the data it needs as arguments
 * and returns a value. No closure over component state.
 */

export type SavedBlock =
	| { kind: 'text'; content: string }
	| { kind: 'thinking'; content: string; reasoningTokens?: number | null }
	| {
			kind: 'tool'
			name: string
			arguments: unknown
			result: unknown
			success: boolean
			executionMs: number
	  }
	| {
			kind: 'subagent'
			agentId: string
			agentName: string
			conversationId: string | null
			task: string
			content: string
			success: boolean
	  }

export type ArtifactCardProps = {
	artifactId: string
	name: string
	contentType: 'markdown' | 'code' | 'json' | 'yaml' | 'plaintext'
	versionSeq: number
	content: string
	focus: 'plan' | 'todo' | 'document' | 'data' | null
	note: string | null
}

/** Coerce a JSONB column value (object, JSON string, or raw) into a record. */
export function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
	if (typeof value !== 'string') return null
	try {
		const parsed = JSON.parse(value) as unknown
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}

/** Coerce a JSONB column value into an array. Returns [] for non-array input. */
export function asArray(value: unknown): unknown[] {
	if (Array.isArray(value)) return value
	if (typeof value !== 'string') return []
	try {
		const parsed = JSON.parse(value) as unknown
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

/** True when the saved block has any visible body the user would care to render. */
export function blockHasRenderableOutput(block: SavedBlock): boolean {
	if (block.kind === 'text' || block.kind === 'thinking') return !!block.content?.trim()
	if (block.kind === 'tool') return !!block.name
	if (block.kind === 'subagent')
		return !!(block.agentName?.trim() || block.task?.trim() || block.content?.trim())
	return false
}

/** Read the questions array from an ask_user tool call's args (preferred) or result (fallback). */
export function getAskUserQuestions(
	argumentsValue: unknown,
	resultValue: unknown,
): Array<{ header: string; question?: string }> {
	const args = asRecord(argumentsValue)
	const result = asRecord(resultValue)
	const fromArgs = Array.isArray(args?.questions) ? args.questions : []
	const fromResult = Array.isArray(result?.questions) ? result.questions : []
	const source = fromArgs.length > 0 ? fromArgs : fromResult

	return source
		.map((q) => {
			const row = asRecord(q)
			const header = typeof row?.header === 'string' ? row.header : ''
			const question = typeof row?.question === 'string' ? row.question : undefined
			return { header, question }
		})
		.filter((q) => q.header.length > 0 || (q.question?.length ?? 0) > 0)
}

/** Look up the resolved answer for a single ask_user question header. */
export function getAskUserAnswer(resultValue: unknown, header: string): string | null {
	const result = asRecord(resultValue)
	const answers = asRecord(result?.answers)
	if (!answers) return null
	const value = answers[header]
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : null
}

/**
 * Extract the props for the inline ArtifactCard from a `present_artifact` /
 * `create_artifact` tool result. Returns null when the result blob is missing
 * required fields — the bubble falls back to the generic tool-result card in
 * that case.
 */
export function getArtifactCardProps(resultValue: unknown): ArtifactCardProps | null {
	const result = asRecord(resultValue)
	if (!result) return null
	const artifactId = typeof result.artifactId === 'string' ? result.artifactId : null
	const name = typeof result.name === 'string' ? result.name : null
	const content = typeof result.content === 'string' ? result.content : null
	const versionSeq = typeof result.versionSeq === 'number' ? result.versionSeq : null
	if (!artifactId || !name || content === null || versionSeq === null) return null
	const contentType = (typeof result.contentType === 'string' ? result.contentType : 'markdown') as
		ArtifactCardProps['contentType']
	const focus =
		result.focus === 'plan' ||
		result.focus === 'todo' ||
		result.focus === 'document' ||
		result.focus === 'data'
			? result.focus
			: null
	const note = typeof result.note === 'string' && result.note.trim() ? result.note : null
	return { artifactId, name, contentType, versionSeq, content, focus, note }
}

/** Lowercase + collapse whitespace for the dedupe-text comparison. */
export function normalizeText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * True when the ask_user question text already appears in either a saved
 * text block on this message or in `messageContent`. Used to suppress the
 * model's redundant inline question when the AskUserCard is already showing
 * the same prompt.
 */
export function askQuestionAlreadyInMessage(
	question: string | undefined,
	blocks: SavedBlock[] | null,
	messageContent: string | null | undefined,
): boolean {
	const q = normalizeText(question ?? '')
	if (!q) return false

	if (blocks) {
		for (const block of blocks) {
			if (block.kind !== 'text') continue
			const text = normalizeText(block.content ?? '')
			if (text.includes(q)) return true
		}
	}

	const messageText = normalizeText(messageContent ?? '')
	return messageText.includes(q)
}
