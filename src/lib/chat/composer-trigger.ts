/**
 * #22 — where the caret is, as far as the composer's suggestion menus are concerned.
 *
 * Pure string work on the textarea's value and caret, with no DOM, so the unit spec pins it.
 *
 * Two triggers:
 *
 * - `@` starts a file mention anywhere a word can start: at the very beginning, or after
 *   whitespace, `(` or `[`. So `see @src/app.ts` triggers and `me@example.com` does not.
 *   The query is everything after the `@` up to the next space.
 * - `/` starts a command, but only as the first character of the message. A command lives
 *   on the first line: `/model son` is the model command with "son" typed after it, and
 *   anything on later lines is left alone. `/usr/bin is broken` is not a command, because
 *   the word after the slash is followed by another slash, not by a space.
 */

/** Longest query a trigger will carry; past this the menu closes rather than searching. */
export const MAX_TRIGGER_QUERY = 200

export type MentionTrigger = {
	kind: 'mention'
	/** Index of the `@`. */
	start: number
	/** Index just past the last character of the query. */
	end: number
	query: string
}

export type CommandTrigger = {
	kind: 'command'
	start: 0
	/** Index just past the command word. */
	end: number
	/** The command word typed so far, without the slash. */
	query: string
}

export type ArgumentTrigger = {
	kind: 'argument'
	/** The command word, lowercased. */
	name: string
	/** Where the argument starts on the first line (after the whitespace that follows the word). */
	start: number
	/** The end of the first line. */
	end: number
	/** What has been typed after the command word on the first line, trimmed. */
	query: string
}

export type ComposerTrigger = MentionTrigger | CommandTrigger | ArgumentTrigger

const MENTION_LEAD = /[\s([]/
const MENTION_CHAR = /[^\s@]/

export function findMentionTrigger(value: string, caret: number): MentionTrigger | null {
	if (caret < 1 || caret > value.length) return null
	// Walk back from the caret to the `@` that opens this token, if there is one.
	let at = -1
	for (let i = caret - 1; i >= 0; i--) {
		const ch = value[i]
		if (ch === '@') {
			at = i
			break
		}
		if (!MENTION_CHAR.test(ch)) return null
		if (caret - i > MAX_TRIGGER_QUERY) return null
	}
	if (at < 0) return null
	if (at > 0 && !MENTION_LEAD.test(value[at - 1])) return null

	let end = caret
	while (end < value.length && MENTION_CHAR.test(value[end])) end++
	const query = value.slice(at + 1, end)
	if (query.length > MAX_TRIGGER_QUERY) return null
	return { kind: 'mention', start: at, end, query }
}

/** The command word at the start of `value`, or null when the value is not a command. */
function commandWord(value: string): { word: string; end: number } | null {
	if (value[0] !== '/') return null
	let end = 1
	while (end < value.length && !/[\s/]/.test(value[end])) end++
	// `/usr/bin`: the word is followed by a slash, not by whitespace or the end.
	if (end < value.length && value[end] === '/') return null
	const word = value.slice(1, end)
	if (word.length > MAX_TRIGGER_QUERY) return null
	return { word, end }
}

function firstLineEnd(value: string): number {
	const newline = value.indexOf('\n')
	return newline < 0 ? value.length : newline
}

export function findSlashTrigger(value: string, caret: number): CommandTrigger | ArgumentTrigger | null {
	const command = commandWord(value)
	if (!command) return null
	const lineEnd = firstLineEnd(value)
	if (caret < 1 || caret > lineEnd) return null
	if (caret <= command.end) return { kind: 'command', start: 0, end: command.end, query: command.word }
	if (!command.word) return null
	let start = command.end
	while (start < lineEnd && /[ \t]/.test(value[start])) start++
	const query = value.slice(start, lineEnd).trim()
	if (query.length > MAX_TRIGGER_QUERY) return null
	return { kind: 'argument', name: command.word.toLowerCase(), start, end: lineEnd, query }
}

/**
 * The trigger at the caret. A mention wins over a command's argument, so `@` still completes
 * a file inside `/research compare @src/a.ts with …`.
 */
export function findComposerTrigger(value: string, caret: number): ComposerTrigger | null {
	return findMentionTrigger(value, caret) ?? findSlashTrigger(value, caret)
}

export function sameTrigger(a: ComposerTrigger | null, b: ComposerTrigger | null): boolean {
	if (!a || !b) return a === b
	if (a.kind !== b.kind || a.start !== b.start || a.end !== b.end || a.query !== b.query) return false
	return a.kind !== 'argument' || (b.kind === 'argument' && a.name === b.name)
}

// ─────────── Accepting a suggestion ───────────

export type Edit = { value: string; caret: number }

/**
 * How a mentioned path is written into the message: as inline code, which reads as a path in
 * the rendered transcript and is unambiguous to the model. Deliberately not `@path` — whether
 * the Agent SDK expands a literal `@path` in a prompt, and against which directory, is not
 * something this app controls.
 */
export function formatMentionPath(path: string): string {
	if (!path.includes('`')) return `\`${path}\``
	// A backtick in the name: a longer fence, padded so a leading or trailing tick survives.
	return `\`\` ${path} \`\``
}

/** Replace `@query` with the formatted path and a space, and put the caret after it. */
export function applyMention(value: string, trigger: MentionTrigger, path: string): Edit {
	const before = value.slice(0, trigger.start)
	const after = value.slice(trigger.end)
	const insert = formatMentionPath(path)
	const spacer = after.length > 0 && /^\s/.test(after) ? '' : ' '
	const next = `${before}${insert}${spacer}${after}`
	return { value: next, caret: before.length + insert.length + spacer.length }
}

/**
 * Insert a bare `@` at the caret, as the `@ Context` button does, with a space in front when
 * it would otherwise be glued to a word.
 */
export function insertMentionTrigger(value: string, caret: number): Edit {
	const at = Math.max(0, Math.min(caret, value.length))
	const before = value.slice(0, at)
	const lead = before.length > 0 && !MENTION_LEAD.test(before[before.length - 1]) ? ' ' : ''
	const next = `${before}${lead}@${value.slice(at)}`
	return { value: next, caret: at + lead.length + 1 }
}

/**
 * Start a command, as the `/ Commands` button does. An empty message becomes `/`; a draft
 * moves down a line under it, so it survives whichever command is picked.
 */
export function insertCommandTrigger(value: string): Edit {
	const command = commandWord(value)
	if (command) {
		// Already a command: the caret goes to the end of its word, which reopens the palette on it.
		return { value, caret: command.end }
	}
	return { value: value.trim() ? `/\n${value}` : '/', caret: 1 }
}

/**
 * Picking a command that takes an argument: `/name ` on the first line with the caret after
 * it, and everything the user had after the command word kept.
 */
export function applyCommandName(value: string, trigger: CommandTrigger, name: string): Edit {
	const rest = value.slice(trigger.end).replace(/^[ \t]+/, '')
	const head = `/${name} `
	// A draft that sat on the same line becomes the argument; one on the next line stays put.
	return { value: `${head}${rest}`, caret: head.length }
}

/**
 * The message with the command removed: the command word goes, and so does the rest of its
 * line when that line was the command's argument (`consumeLine`). What remains is the draft.
 */
export function stripCommand(value: string, options: { consumeLine: boolean }): string {
	const command = commandWord(value)
	if (!command) return value
	const lineEnd = firstLineEnd(value)
	const restOfLine = options.consumeLine ? '' : value.slice(command.end, lineEnd).trim()
	const below = lineEnd < value.length ? value.slice(lineEnd + 1) : ''
	if (restOfLine && below) return `${restOfLine}\n${below}`
	return restOfLine || below
}

// ─────────── Sending a command ───────────

export type ParsedCommand = {
	/** The command word, lowercased. */
	name: string
	/**
	 * What follows the word on its own line, trimmed: a choice's name, or a free-text argument
	 * such as a research question. Later lines are the draft, never part of the argument.
	 */
	lineArgument: string
}

/** The command a message starts with, when it starts with one. */
export function parseSlashCommand(value: string): ParsedCommand | null {
	const command = commandWord(value)
	if (!command || !command.word) return null
	const lineEnd = firstLineEnd(value)
	return {
		name: command.word.toLowerCase(),
		lineArgument: value.slice(command.end, lineEnd).trim(),
	}
}
