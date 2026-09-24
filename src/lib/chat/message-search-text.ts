/**
 * The text a message is found by in conversation search (#18).
 *
 * Search has to find *work*, not just prose. "The run where it touched options.server.ts" or
 * "the one where it opened that PR" lives in a tool call — a file path in `Edit`'s arguments,
 * a command in `Bash`'s, a URL in `gh pr create`'s output — not in anything the model said.
 * So besides the message text, each tool call contributes one readable line: its name, the
 * paths, commands and short arguments it was given, and any links in what it returned.
 *
 * What is deliberately left out:
 *   - raw tool output. A `Read` or a `Write` result can be megabytes; indexing it would make
 *     every search match every file the agent ever opened, and Postgres refuses a tsvector
 *     over ~1MB outright. Only the links in it are kept.
 *   - file bodies and edit payloads (`Write`'s `content`, `Edit`'s `old_string` /
 *     `new_string`). What a file says belongs to the file; the path is what finds the turn.
 *   - thinking and run notices. Neither is something a person searches their history for.
 *   - system messages (agent-switch anchors). They are instructions to the model.
 *
 * Paths get special treatment. Postgres parses `src/lib/engine/options.server.ts` as one
 * `file` token and `options.server.ts` as one `host` token, so without help a search for
 * `options` or `engine/options.server.ts` would miss the very turn that edited it. Every path
 * is therefore followed by its basename and its segments as plain words, and the query side
 * (`searchQueryParts` in ./conversation-search) turns a path-shaped search into the matching
 * phrase of segments.
 *
 * The output is capped (`SEARCH_TEXT_MAX_CHARS`), so an insert can never fail on the
 * tsvector size limit however large the message is.
 *
 * Pure and dependency-free: used by the server-side index writer and by specs running in the
 * plain Playwright loader.
 */

/**
 * Bump when what this builder emits changes. The boot backfill rewrites every indexed row
 * whose `builder_version` is older, so the whole history picks up the new rules.
 *
 * 2 — a delegated child's own tool calls (#32's card transcript), and its report when it
 * said nothing on the way.
 */
export const SEARCH_BUILDER_VERSION = 2

/** Hard cap on the built text. Far below Postgres's ~1MB tsvector limit. */
export const SEARCH_TEXT_MAX_CHARS = 60_000

/** How much of the message text itself is indexed. The rest of the budget is for tool lines. */
const CONTENT_MAX_CHARS = 40_000

/** Cap for an argument that is always indexed. */
const ARGUMENT_MAX_CHARS = 2_000

/** Any other string argument is indexed only when it is at most this long (titles, names, ids). */
const LOOSE_ARGUMENT_MAX_CHARS = 300

const SUBAGENT_MAX_CHARS = 2_000
/** Distinct tool calls of a delegated child that are indexed (#32). */
const SUBAGENT_MAX_TOOL_CALLS = 50
const TODO_MAX_CHARS = 2_000

/** A tool result is scanned for links only — its head and its tail, where `gh` prints the URL. */
const RESULT_HEAD_CHARS = 4_000
const RESULT_TAIL_CHARS = 2_000
const MAX_RESULT_URLS = 20

/** Path-like tokens in prose that get their segments spelled out. */
const MAX_TEXT_PATHS = 100

/** Arguments that say what a call was about, indexed whatever their length (capped). */
const INDEXED_ARGUMENTS = new Set([
	'file_path',
	'path',
	'notebook_path',
	'command',
	'description',
	'pattern',
	'glob',
	'url',
	'query',
	'prompt',
	'subagent_type',
	'skill',
])

/** Arguments never indexed: file bodies and edit payloads. */
const EXCLUDED_ARGUMENTS = new Set(['content', 'old_string', 'new_string', 'new_source', 'edits'])

/** Arguments whose value is a path, and so gets its segments spelled out. */
const PATH_ARGUMENTS = new Set(['file_path', 'path', 'notebook_path'])

// Includes the two markers the search snippet is highlighted with (./conversation-search).
// Stripped from the indexed text so a message can never forge a highlight.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

const URL_PATTERN = /https?:\/\/[^\s"'<>`()[\]{}]+/g

/** A token with a `/`, `\` or `.` between word characters: a path, a file name, a host. */
const PATH_LIKE_PATTERN = /[\p{L}\p{N}_~@-]+(?:[\\/.][\p{L}\p{N}_~@-]+)+/gu

export type SearchableAttachment = { filename?: unknown }

export type SearchableMessage = {
	role: string
	content: string
	metadata?: unknown
	attachments?: unknown
	/** The pre-blocks shape of tool calls. Only read when `metadata.blocks` is absent. */
	toolCalls?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}

function clip(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value
}

/**
 * `src/lib/engine/options.server.ts` → the path itself, its basename, and its segments as
 * words: `… options.server.ts src lib engine options server ts`.
 */
export function pathSearchTerms(path: string): string {
	const trimmed = path.trim()
	if (!trimmed) return ''
	const basename = trimmed.split(/[\\/]+/).filter(Boolean).pop() ?? trimmed
	const segments = trimmed.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
	const parts = [trimmed]
	if (basename !== trimmed) parts.push(basename)
	if (segments.length > 1) parts.push(segments.join(' '))
	return parts.join(' ')
}

/** Segments for every path-like token in free text (a command, a message), de-duplicated. */
function pathTermsIn(text: string, limit: number): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const match of text.matchAll(PATH_LIKE_PATTERN)) {
		const token = match[0]
		if (seen.has(token) || !/\p{L}/u.test(token)) continue
		seen.add(token)
		const segments = token.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
		if (segments.length > 1) out.push(segments.join(' '))
		if (out.length >= limit) break
	}
	return out
}

function urlsIn(text: string): string[] {
	const scanned =
		text.length > RESULT_HEAD_CHARS + RESULT_TAIL_CHARS
			? `${text.slice(0, RESULT_HEAD_CHARS)} ${text.slice(-RESULT_TAIL_CHARS)}`
			: text
	const urls = new Set<string>()
	for (const match of scanned.matchAll(URL_PATTERN)) {
		urls.add(match[0].replace(/[.,;:!?]+$/, ''))
		if (urls.size >= MAX_RESULT_URLS) break
	}
	return [...urls]
}

function parseArguments(value: unknown): Record<string, unknown> | null {
	const record = asRecord(value)
	if (record) return record
	if (typeof value !== 'string' || !value.trim().startsWith('{')) return null
	try {
		return asRecord(JSON.parse(value))
	} catch {
		return null
	}
}

function resultText(value: unknown): string {
	if (typeof value === 'string') return value
	if (value === null || value === undefined) return ''
	try {
		return JSON.stringify(value)
	} catch {
		return ''
	}
}

/** One readable line for a tool call: `Edit: src/lib/x.ts … | Bash: bun run check …`. */
function toolLine(item: Record<string, unknown>): string {
	const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'tool'
	const parts: string[] = []
	const paths: string[] = []

	const details = asRecord(item.details)
	if (details) {
		if (typeof details.path === 'string') paths.push(details.path)
		if (typeof details.command === 'string') parts.push(clip(details.command, ARGUMENT_MAX_CHARS))
		if (typeof details.description === 'string') parts.push(clip(details.description, ARGUMENT_MAX_CHARS))
		if (details.kind === 'todo') {
			const items = asArray(details.items)
				.map((entry) => asRecord(entry)?.content)
				.filter((text): text is string => typeof text === 'string')
			if (items.length > 0) parts.push(clip(items.join('; '), TODO_MAX_CHARS))
		}
	}

	const args = parseArguments(item.arguments)
	if (args) {
		for (const [key, value] of Object.entries(args)) {
			if (typeof value !== 'string' || !value.trim() || EXCLUDED_ARGUMENTS.has(key)) continue
			if (PATH_ARGUMENTS.has(key)) {
				paths.push(value)
			} else if (INDEXED_ARGUMENTS.has(key)) {
				parts.push(clip(value, ARGUMENT_MAX_CHARS))
			} else if (value.length <= LOOSE_ARGUMENT_MAX_CHARS) {
				parts.push(value)
			}
		}
	}

	const urls = urlsIn(resultText(item.result))

	const uniquePaths = [...new Set(paths.map((p) => clip(p.trim(), ARGUMENT_MAX_CHARS)).filter(Boolean))]
	const text = [...uniquePaths.map(pathSearchTerms), ...new Set(parts), ...urls].join(' ')
	// Commands and descriptions carry paths too (`git diff src/lib/x.ts`).
	const extra = pathTermsIn([...parts, ...urls].join(' '), 20)
	return [`${name}:`, text, ...extra].filter(Boolean).join(' ')
}

/**
 * A delegated child: what it was asked, what it said (or, when it said nothing on the way,
 * its final report), and the tools it called with what each touched.
 *
 * Since #32 the delegation has no `tool` block of its own — the child's card is its only
 * record — and the child's calls are kept on the card's `transcript`, each with a one-line
 * label (a path, a command, a pattern). Those labels are the child's work, and a turn that
 * delegated an edit has to be found by the file the child edited just as if the parent had
 * edited it.
 */
function subagentLine(item: Record<string, unknown>): string {
	const name = typeof item.agentName === 'string' ? item.agentName : 'subagent'
	const task = typeof item.task === 'string' ? clip(item.task, SUBAGENT_MAX_CHARS) : ''
	const said = typeof item.content === 'string' && item.content.trim() ? item.content : ''
	const report = asRecord(item.details)?.report
	const content = clip(said || (typeof report === 'string' ? report : ''), SUBAGENT_MAX_CHARS)

	const calls = new Set<string>()
	for (const entry of asArray(item.transcript)) {
		const call = asRecord(entry)
		if (call?.kind !== 'tool' || typeof call.name !== 'string' || !call.name.trim()) continue
		// A label past its cap ends in an ellipsis, which is not part of the path or command.
		const label = typeof call.label === 'string' ? call.label.replace(/…$/, '').trim() : ''
		calls.add(label ? `${call.name.trim()} ${label}` : call.name.trim())
		if (calls.size >= SUBAGENT_MAX_TOOL_CALLS) break
	}
	const work = clip([...calls].join(' '), SUBAGENT_MAX_CHARS)
	// Paths in the labels get their segments spelled out, as a parent's commands do.
	const extra = pathTermsIn(work, 20)

	return [`Subagent ${name}:`, task, content, work, ...extra].filter(Boolean).join(' ')
}

/** Tool calls and subagent spans, in order, from `metadata.blocks` (or the older `toolCalls`). */
function workLines(message: SearchableMessage): string[] {
	const blocks = asArray(asRecord(message.metadata)?.blocks)
	const items = blocks.length > 0 ? blocks : asArray(message.toolCalls)
	const lines: string[] = []
	for (const entry of items) {
		const item = asRecord(entry)
		if (!item) continue
		const kind = item.kind
		// Text is already in `content`; thinking and notices are not what anyone searches for.
		if (kind === 'text' || kind === 'thinking' || kind === 'notice') continue
		if (kind === 'subagent') lines.push(subagentLine(item))
		else if (kind === 'tool' || typeof item.name === 'string') lines.push(toolLine(item))
	}
	return lines
}

function attachmentLine(attachments: unknown): string {
	const names = asArray(attachments)
		.map((entry) => asRecord(entry)?.filename)
		.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
	if (names.length === 0) return ''
	return `Attachments: ${names.map((name) => pathSearchTerms(clip(name, ARGUMENT_MAX_CHARS))).join(' ')}`
}

/**
 * The text to index for one message. Empty for system messages; never longer than
 * `SEARCH_TEXT_MAX_CHARS`.
 */
export function buildMessageSearchText(message: SearchableMessage): string {
	if (message.role === 'system') return ''

	const content = clip(typeof message.content === 'string' ? message.content : '', CONTENT_MAX_CHARS)
	const lines: string[] = []
	if (content.trim()) lines.push(content)

	const attachments = attachmentLine(message.attachments)
	if (attachments) lines.push(attachments)

	lines.push(...workLines(message))

	// Paths mentioned in the text itself ("I updated options.server.ts") get the same
	// segment expansion, so a path-shaped search finds prose as well as tool calls.
	const prosePaths = pathTermsIn(content, MAX_TEXT_PATHS)
	if (prosePaths.length > 0) lines.push(prosePaths.join(' '))

	return clip(lines.join('\n').replace(CONTROL_CHARACTERS, ' '), SEARCH_TEXT_MAX_CHARS)
}
