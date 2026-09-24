/**
 * Conversation search (#18) — the pieces shared by the server query and the sidebar.
 *
 * Imports nothing, so the browser can use it and specs can load it in the plain Playwright
 * loader.
 */

/** Shortest and longest search the sidebar sends. One character matches everything. */
export const SEARCH_QUERY_MIN_CHARS = 2
export const SEARCH_QUERY_MAX_CHARS = 200

/**
 * The snippet's highlight markers. Control characters rather than `<mark>` so the snippet is
 * plain text end to end: it is built from user and agent content, and the sidebar turns the
 * markers into `<mark>` elements itself instead of rendering HTML from the database. The
 * indexed text has these stripped (`buildMessageSearchText`), so a message cannot forge one.
 */
export const SNIPPET_START = '\u0002'
export const SNIPPET_STOP = '\u0003'

export type SnippetPart = { text: string; mark: boolean }

/** Split a highlighted snippet into plain and marked runs, for rendering as text nodes. */
export function splitSnippet(snippet: string): SnippetPart[] {
	const parts: SnippetPart[] = []
	let mark = false
	let buffer = ''
	const flush = () => {
		if (buffer) parts.push({ text: buffer, mark })
		buffer = ''
	}
	for (const char of snippet) {
		if (char === SNIPPET_START) {
			flush()
			mark = true
		} else if (char === SNIPPET_STOP) {
			flush()
			mark = false
		} else {
			buffer += char
		}
	}
	flush()
	return parts
}

/** Whitespace collapsed, control characters dropped. */
export function normalizeSearchInput(raw: string): string {
	return raw
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

export type SearchQueryParts = {
	/** The query as typed, minus a trailing prefix term — for `websearch_to_tsquery`. */
	exact: string | null
	/**
	 * The same, with each path-shaped term (`engine/options.server.ts`) rewritten as a quoted
	 * phrase of its segments (`"engine options server ts"`). The indexed text spells every
	 * path out that way, so this is what finds a partial path. Null when nothing changed.
	 */
	segmented: string | null
	/** The last word as a prefix match (`deplo:*`), so results appear while typing. */
	prefix: string | null
}

const PLAIN_WORD = /^[\p{L}\p{N}]{2,}$/u
const PATH_SHAPED = /[\p{L}\p{N}][^\p{L}\p{N}\s]+[\p{L}\p{N}]/u
const WEBSEARCH_OPERATORS = new Set(['or', 'and', 'not'])

/**
 * How a typed search becomes a Postgres text query: `(exact OR segmented) AND prefix`, each
 * part optional. See `searchConversations` in ./message-search.server for the SQL.
 */
export function searchQueryParts(raw: string): SearchQueryParts {
	const cleaned = normalizeSearchInput(raw)
	if (!cleaned) return { exact: null, segmented: null, prefix: null }

	const terms = cleaned.split(' ')
	const last = terms[terms.length - 1]
	const balancedQuotes = (cleaned.match(/"/g) ?? []).length % 2 === 0
	const usesOr = terms.slice(0, -1).some((term) => term.toLowerCase() === 'or')

	let prefix: string | null = null
	if (balancedQuotes && !usesOr && PLAIN_WORD.test(last) && !WEBSEARCH_OPERATORS.has(last.toLowerCase())) {
		prefix = `${last.toLowerCase()}:*`
		terms.pop()
	}

	const exact = terms.join(' ') || null
	const segmentedTerms = terms.map((term) => {
		if (term.includes('"') || term.startsWith('-') || !PATH_SHAPED.test(term)) return term
		const segments = term.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
		return segments.length > 1 ? `"${segments.join(' ')}"` : term
	})
	const segmented = segmentedTerms.join(' ') || null

	return { exact, segmented: segmented !== exact ? segmented : null, prefix }
}
