/**
 * #22 — fuzzy matching for the composer's suggestion menus: `@` file mentions and the `/`
 * command palette.
 *
 * Pure: no `node:` imports and no `$lib` aliases, so the server's file search and the
 * browser's command palette rank with the same rules, and the unit spec imports it directly.
 *
 * A query matches when its characters appear in order in the candidate, case-insensitively
 * ("mm" matches "mention-match"). Among the ways a query can line up with a candidate, the
 * best-scoring one wins: matches at the start of a word (after `/`, `-`, `_`, `.`, a space,
 * or a camelCase hump) and runs of adjacent characters score higher; gaps cost a little.
 */

export type FuzzyMatch = {
	score: number
	/** Positions in the candidate that matched, one per query character, ascending. */
	indices: number[]
}

const SCORE_MATCH = 16
const GAP_START = 3
const GAP_EXTENSION = 1
const BONUS_CONSECUTIVE = 5
const BONUS_FIRST_CHAR = 10
const BONUS_AFTER_SLASH = 10
const BONUS_AFTER_SEPARATOR = 8
const BONUS_CAMEL = 7
const BONUS_DIGIT = 4

/** Above this many query × candidate cells the exact alignment is skipped for a greedy one. */
const MAX_ALIGNMENT_CELLS = 32_768

const NEG = -1e9

function isUpper(c: string) {
	return c >= 'A' && c <= 'Z'
}
function isLower(c: string) {
	return c >= 'a' && c <= 'z'
}
function isDigit(c: string) {
	return c >= '0' && c <= '9'
}

/** What matching the character at `i` is worth on top of the match itself. */
function positionBonus(text: string, i: number): number {
	if (i === 0) return BONUS_FIRST_CHAR
	const prev = text[i - 1]
	if (prev === '/' || prev === '\\') return BONUS_AFTER_SLASH
	if (prev === '-' || prev === '_' || prev === '.' || prev === ' ') return BONUS_AFTER_SEPARATOR
	const ch = text[i]
	if (isLower(prev) && isUpper(ch)) return BONUS_CAMEL
	if (!isDigit(prev) && isDigit(ch)) return BONUS_DIGIT
	return 0
}

function isSubsequence(q: string, t: string): boolean {
	let j = 0
	for (let i = 0; i < t.length && j < q.length; i++) if (t[i] === q[j]) j++
	return j === q.length
}

/** First-fit alignment, for pathological lengths only. Still a valid match, just not the best one. */
function greedyMatch(q: string, t: string, text: string): FuzzyMatch {
	const indices: number[] = []
	let score = 0
	let prev = -2
	for (let i = 0, j = 0; i < t.length && j < q.length; i++) {
		if (t[i] !== q[j]) continue
		score += SCORE_MATCH + positionBonus(text, i) + (i === prev + 1 ? BONUS_CONSECUTIVE : prev >= 0 ? -GAP_START : 0)
		indices.push(i)
		prev = i
		j++
	}
	return { score, indices }
}

/**
 * Score `query` against `text`, or `null` when it does not match at all.
 *
 * An empty query matches everything with a score of 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
	const m = query.length
	if (m === 0) return { score: 0, indices: [] }
	const n = text.length
	if (m > n) return null
	const q = query.toLowerCase()
	const t = text.toLowerCase()
	if (!isSubsequence(q, t)) return null
	if (m * n > MAX_ALIGNMENT_CELLS) return greedyMatch(q, t, text)

	const bonus = new Int8Array(n)
	for (let j = 0; j < n; j++) bonus[j] = positionBonus(text, j)

	// best[i*n + j]: the best score with query[i] matched at text[j]. from[…]: where query[i-1] sat.
	const best = new Float64Array(m * n).fill(NEG)
	const from = new Int32Array(m * n).fill(-1)

	for (let i = 0; i < m; i++) {
		const row = i * n
		const prevRow = row - n
		// The best predecessor at least two characters back, already charged for the gap.
		let gapBest = NEG
		let gapFrom = -1
		for (let j = i; j < n; j++) {
			if (i > 0 && j >= 2) {
				const entering = best[prevRow + j - 2] - GAP_START
				const extended = gapBest - GAP_EXTENSION
				if (entering >= extended) {
					gapBest = entering
					gapFrom = j - 2
				} else {
					gapBest = extended
				}
			}
			if (t[j] !== q[i]) continue
			const own = SCORE_MATCH + bonus[j]
			if (i === 0) {
				best[row + j] = own
				continue
			}
			let score = NEG
			let source = -1
			const adjacent = best[prevRow + j - 1]
			if (adjacent > NEG / 2) {
				score = adjacent + BONUS_CONSECUTIVE
				source = j - 1
			}
			if (gapBest > NEG / 2 && gapBest > score) {
				score = gapBest
				source = gapFrom
			}
			if (source < 0) continue
			best[row + j] = score + own
			from[row + j] = source
		}
	}

	const lastRow = (m - 1) * n
	let end = -1
	let top = NEG
	for (let j = m - 1; j < n; j++) {
		if (best[lastRow + j] > top) {
			top = best[lastRow + j]
			end = j
		}
	}
	if (end < 0) return null

	const indices = new Array<number>(m)
	for (let i = m - 1, j = end; i >= 0; i--) {
		indices[i] = j
		j = from[i * n + j]
	}
	return { score: top, indices }
}

// ─────────── File paths (`@` mentions) ───────────

/** A match inside the file name beats the same match spread across the directories. */
const BONUS_BASENAME = 24
const BONUS_PREFIX = 12
const BONUS_EXACT = 24
const PENALTY_DEPTH = 1.5
const PENALTY_LENGTH = 0.05

export type RankedPath = {
	/** Workspace-relative, `/`-separated. A directory keeps its trailing `/`. */
	path: string
	isDirectory: boolean
	score: number
	/** Matched positions in `path`, for highlighting. */
	indices: number[]
}

function depthOf(path: string): number {
	let depth = 0
	for (let i = 0; i < path.length; i++) if (path[i] === '/') depth++
	return depth
}

function stem(name: string): string {
	const dot = name.lastIndexOf('.')
	return dot > 0 ? name.slice(0, dot) : name
}

/**
 * Rank workspace paths against what was typed after `@`.
 *
 * - No query: the shallowest entries first, directories before files, then by name — a
 *   look at the top of the tree.
 * - A query with no `/` is matched against the file name first, and only against the whole
 *   path when the name alone does not contain it.
 * - A query with a `/` is matched against the whole path, so `lib/chat` narrows by folder.
 *
 * Shorter, shallower paths win ties.
 */
export function rankPaths(query: string, paths: readonly string[], limit = 20): RankedPath[] {
	const q = query.trim()
	if (!q) {
		return paths
			.map((path) => ({ path, isDirectory: path.endsWith('/'), depth: depthOf(path.endsWith('/') ? path.slice(0, -1) : path) }))
			.sort(
				(a, b) =>
					a.depth - b.depth || Number(b.isDirectory) - Number(a.isDirectory) || a.path.localeCompare(b.path),
			)
			.slice(0, limit)
			.map(({ path, isDirectory }) => ({ path, isDirectory, score: 0, indices: [] }))
	}

	const lowerQuery = q.toLowerCase()
	const wholePath = q.includes('/')
	const ranked: RankedPath[] = []
	for (const path of paths) {
		const isDirectory = path.endsWith('/')
		const bare = isDirectory ? path.slice(0, -1) : path
		let score = 0
		let indices: number[] | null = null

		if (!wholePath) {
			const slash = bare.lastIndexOf('/')
			const name = bare.slice(slash + 1)
			const inName = fuzzyMatch(q, name)
			if (inName) {
				const lowerName = name.toLowerCase()
				score = inName.score + BONUS_BASENAME
				if (lowerName.startsWith(lowerQuery)) score += BONUS_PREFIX
				if (lowerName === lowerQuery || stem(lowerName) === lowerQuery) score += BONUS_EXACT
				indices = inName.indices.map((i) => i + slash + 1)
			}
		}
		if (!indices) {
			const inPath = fuzzyMatch(q, bare)
			if (!inPath) continue
			score = inPath.score
			indices = inPath.indices
		}

		score -= depthOf(bare) * PENALTY_DEPTH + bare.length * PENALTY_LENGTH
		ranked.push({ path, isDirectory, score, indices })
	}

	ranked.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
	return ranked.slice(0, limit)
}

// ─────────── Anything else (commands, choices) ───────────

export type RankedItem<T> = {
	item: T
	score: number
	/** Matched positions in the key that matched best. */
	indices: number[]
	/** Which of the item's keys matched best; 0 is its primary name. */
	key: number
}

/**
 * Rank items by their best-matching key (a command's name and aliases, a choice's label and
 * id). An empty query keeps the given order. The sort is stable, so equal scores keep it too.
 */
export function rankItems<T>(
	query: string,
	items: readonly T[],
	keys: (item: T) => readonly string[],
	limit = Number.POSITIVE_INFINITY,
): RankedItem<T>[] {
	const q = query.trim()
	if (!q) return items.slice(0, limit).map((item) => ({ item, score: 0, indices: [], key: 0 }))
	const lowerQuery = q.toLowerCase()
	const ranked: RankedItem<T>[] = []
	for (const item of items) {
		let top: RankedItem<T> | null = null
		keys(item).forEach((candidate, key) => {
			const match = fuzzyMatch(q, candidate)
			if (!match) return
			const lower = candidate.toLowerCase()
			let score = match.score
			if (lower.startsWith(lowerQuery)) score += BONUS_PREFIX
			if (lower === lowerQuery) score += BONUS_EXACT
			// The primary name wins a tie with an alias.
			if (key > 0) score -= 1
			if (!top || score > top.score) top = { item, score, indices: match.indices, key }
		})
		if (top) ranked.push(top)
	}
	ranked.sort((a, b) => b.score - a.score)
	return ranked.slice(0, limit)
}

// ─────────── Highlighting ───────────

export type Segment = { text: string; match: boolean }

/** Split `text` into runs of matched and unmatched characters, for rendering a highlight. */
export function highlightSegments(text: string, indices: readonly number[] = []): Segment[] {
	if (indices.length === 0) return text ? [{ text, match: false }] : []
	const hit = new Set(indices)
	const segments: Segment[] = []
	for (let i = 0; i < text.length; i++) {
		const match = hit.has(i)
		const last = segments[segments.length - 1]
		if (last && last.match === match) last.text += text[i]
		else segments.push({ text: text[i], match })
	}
	return segments
}

/**
 * A path as the menu shows it: the name on top, the folder it is in underneath, each with
 * its own share of the matched positions.
 */
export function splitPathForDisplay(
	path: string,
	indices: readonly number[] = [],
): { name: string; nameIndices: number[]; folder: string; folderIndices: number[] } {
	const bare = path.endsWith('/') ? path.slice(0, -1) : path
	const slash = bare.lastIndexOf('/')
	const name = path.slice(slash + 1)
	const folder = slash < 0 ? '' : bare.slice(0, slash + 1)
	return {
		name,
		nameIndices: indices.filter((i) => i > slash).map((i) => i - slash - 1),
		folder,
		folderIndices: indices.filter((i) => i <= slash),
	}
}

// ─────────── The `@` search's wire shape ───────────

export type MentionResult = {
	path: string
	isDirectory: boolean
	indices: number[]
}

export type MentionSearchResult =
	| { ok: true; results: MentionResult[]; truncated: boolean }
	| {
			ok: false
			/**
			 * - `no-workspace`: there is no directory whose files a turn could open by these paths
			 * - `not-found`: no such conversation for this user
			 * - `invalid`: the query itself was refused
			 */
			reason: 'no-workspace' | 'not-found' | 'invalid'
			message: string
	  }
