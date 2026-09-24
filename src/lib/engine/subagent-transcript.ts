/**
 * A delegated child's own transcript (#32): what it said and which tools it called, in the
 * order it did them.
 *
 * The child's messages arrive on the parent's stream marked with `parent_tool_use_id`, and
 * `./stream.server` routes them into `subagent_*` frames. The card used to keep two separate
 * piles — all of the child's text concatenated, and a list of tool names — which lost the
 * one thing a transcript is for: that it read three files, said what it found, then ran the
 * tests. This keeps the sequence.
 *
 * The engine builds one for the persisted block and the chat page builds one from the same
 * frames for the live card, so both call these helpers and cannot disagree about the shape.
 *
 * Capped, because it is persisted twice (`chat_runs.stream_blocks` and the assistant
 * message's metadata): a runaway child must not write megabytes per turn. Past the cap the
 * transcript stops growing and says so; the child's final report still arrives separately,
 * in `SubagentDetails.report`.
 *
 * Pure and dependency-free, like `./tool-result-details`, so the page and the specs can
 * import it.
 */

/** Entries kept per child. */
export const MAX_TRANSCRIPT_ENTRIES = 200

/** Characters of child text kept per child, across all its text entries. */
export const MAX_TRANSCRIPT_CHARS = 20_000

/** Characters of a tool call's one-line label. */
const MAX_LABEL_CHARS = 120

export type SubagentTranscriptEntry =
	| { kind: 'text'; text: string }
	| {
			kind: 'tool'
			name: string
			/** A short hint at what the call touched — a path, a pattern, a command. */
			label?: string | null
			/** Undefined while running, then whether it succeeded. */
			success?: boolean
	  }

export type SubagentTranscript = {
	entries: SubagentTranscriptEntry[]
	/** True once anything was dropped to stay inside the caps. */
	truncated: boolean
}

export function emptyTranscript(): SubagentTranscript {
	return { entries: [], truncated: false }
}

function textLength(entries: readonly SubagentTranscriptEntry[]): number {
	let total = 0
	for (const entry of entries) if (entry.kind === 'text') total += entry.text.length
	return total
}

/** Append child text, joining it to the previous entry when that was text too. */
export function appendTranscriptText(transcript: SubagentTranscript, text: string): SubagentTranscript {
	if (!text) return transcript
	const room = MAX_TRANSCRIPT_CHARS - textLength(transcript.entries)
	if (room <= 0) return { ...transcript, truncated: true }
	const kept = text.length > room ? text.slice(0, room) : text
	const truncated = transcript.truncated || kept.length < text.length

	const last = transcript.entries[transcript.entries.length - 1]
	if (last && last.kind === 'text') {
		return {
			entries: [...transcript.entries.slice(0, -1), { kind: 'text', text: last.text + kept }],
			truncated,
		}
	}
	if (transcript.entries.length >= MAX_TRANSCRIPT_ENTRIES) return { ...transcript, truncated: true }
	return { entries: [...transcript.entries, { kind: 'text', text: kept }], truncated }
}

/** Append a tool call the child made. */
export function appendTranscriptToolCall(
	transcript: SubagentTranscript,
	name: string,
	label?: string | null,
): SubagentTranscript {
	if (transcript.entries.length >= MAX_TRANSCRIPT_ENTRIES) return { ...transcript, truncated: true }
	return {
		entries: [...transcript.entries, { kind: 'tool', name, ...(label ? { label } : {}) }],
		truncated: transcript.truncated,
	}
}

/**
 * Stamp the verdict on the child's most recent unsettled call with this name. Children call
 * tools in parallel too, so "the last entry" is not necessarily the one that just finished.
 */
export function settleTranscriptToolCall(
	transcript: SubagentTranscript,
	name: string,
	success: boolean,
): SubagentTranscript {
	for (let i = transcript.entries.length - 1; i >= 0; i--) {
		const entry = transcript.entries[i]
		if (entry.kind === 'tool' && entry.name === name && entry.success === undefined) {
			const entries = transcript.entries.slice()
			entries[i] = { ...entry, success }
			return { entries, truncated: transcript.truncated }
		}
	}
	return transcript
}

const LABEL_FIELDS = ['file_path', 'path', 'notebook_path', 'pattern', 'command', 'url', 'query', 'description'] as const

/**
 * A one-line hint at what a call touched, read off its input. Never the whole input: a
 * `Write` carries the file's contents, and a transcript line is not the place for them.
 */
export function toolCallLabel(input: unknown): string | null {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return null
	const record = input as Record<string, unknown>
	for (const field of LABEL_FIELDS) {
		const value = record[field]
		if (typeof value !== 'string') continue
		const line = value.replace(/\s+/g, ' ').trim()
		if (!line) continue
		return line.length > MAX_LABEL_CHARS ? `${line.slice(0, MAX_LABEL_CHARS - 1)}…` : line
	}
	return null
}

/**
 * A transcript for a block persisted before transcripts existed: its text, then its calls.
 * The order between the two was never recorded, so this is the honest reconstruction.
 */
export function transcriptFromLegacy(block: {
	content?: string | null
	toolCalls?: ReadonlyArray<{ name: string; success?: boolean }> | null
}): SubagentTranscriptEntry[] {
	const entries: SubagentTranscriptEntry[] = []
	if (block.content?.trim()) entries.push({ kind: 'text', text: block.content })
	for (const call of block.toolCalls ?? []) {
		entries.push({ kind: 'tool', name: call.name, ...(call.success !== undefined ? { success: call.success } : {}) })
	}
	return entries
}
