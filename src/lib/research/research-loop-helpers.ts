import type { ResearchSourceRow } from './research.schema'

/**
 * Wave 4 #18 phase 2 — pure helpers for the research orchestrator loop.
 *
 * Lives in its own module (no $env / db / SvelteKit deps) so unit tests can pin parser
 * + URL-selection + citation-formatting behavior without spinning up the LLM. The loop
 * itself in `research.server.ts` imports these.
 */

/**
 * Parse a planning LLM response into a clean array of sub-questions.
 * The planner is instructed to return JSON `{"subQuestions": ["...", "..."]}` but real models
 * sometimes wrap in ```json fences or include preamble text. Falls back to extracting any
 * outer `{...}` substring + last-ditch sentence-split if no JSON found.
 */
export function parsePlannerResponse(raw: string): string[] {
	const trimmed = raw.trim()
	if (!trimmed) return []

	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
	const candidate = fenced ? fenced[1].trim() : trimmed

	// Try direct JSON parse first.
	const parsed = tryParseJson(candidate)
	if (parsed && Array.isArray(parsed.subQuestions)) {
		return cleanSubQuestions(parsed.subQuestions)
	}

	// Try outermost {...} substring.
	const start = candidate.indexOf('{')
	const end = candidate.lastIndexOf('}')
	if (start >= 0 && end > start) {
		const slice = candidate.slice(start, end + 1)
		const reparsed = tryParseJson(slice)
		if (reparsed && Array.isArray(reparsed.subQuestions)) {
			return cleanSubQuestions(reparsed.subQuestions)
		}
	}

	// Last-ditch fallback: split on lines that look like numbered/bulleted questions.
	const lines = candidate
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s*/, '').trim())
		.filter((l) => l.length >= 8 && l.length < 240)
	return cleanSubQuestions(lines).slice(0, 5)
}

function tryParseJson(s: string): { subQuestions?: unknown } | null {
	try {
		return JSON.parse(s) as { subQuestions?: unknown }
	} catch {
		return null
	}
}

function cleanSubQuestions(raw: unknown[]): string[] {
	return raw
		.filter((q): q is string => typeof q === 'string')
		.map((q) => q.trim())
		.filter((q) => q.length >= 4 && q.length < 240)
		.slice(0, 8) // hard cap so a runaway planner can't generate 50 sub-questions
}

/**
 * Pick up to N URLs from search results, preferring high-trust domains and avoiding
 * known low-value sources. Pure scoring — caller decides what to fetch.
 *
 * Scoring rules:
 *   - .gov / .edu / .org → +3
 *   - wikipedia.org → +2
 *   - github.com / arxiv.org → +2
 *   - pdf links → +1 (likely primary source)
 *   - blog/medium/substack → +0 (neutral)
 *   - pinterest/quora/reddit/instagram → -2 (low-signal social)
 *   - paywall hint domains (nytimes/wsj/ft) → -1
 *
 * Ties are broken by original search rank (preserves SearXNG's relevance signal).
 */
export type SearchHit = { url: string; title?: string; snippet?: string; rank?: number }

export function pickUrlsToFetch(hits: SearchHit[], limit = 3): SearchHit[] {
	const scored = hits.map((hit, idx) => ({
		hit,
		score: scoreUrl(hit.url),
		rank: hit.rank ?? idx,
	}))
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score
		return a.rank - b.rank // lower rank = better
	})
	// Dedupe by hostname so we don't fetch 3 pages from the same site.
	const seen = new Set<string>()
	const picked: SearchHit[] = []
	for (const { hit } of scored) {
		const host = hostnameFromUrl(hit.url)
		if (host && seen.has(host)) continue
		if (host) seen.add(host)
		picked.push(hit)
		if (picked.length >= limit) break
	}
	return picked
}

function scoreUrl(url: string): number {
	let score = 0
	const lower = url.toLowerCase()
	if (/\.gov(\/|$)/.test(lower) || /\.edu(\/|$)/.test(lower)) score += 3
	if (/\.org(\/|$)/.test(lower)) score += 2
	if (lower.includes('wikipedia.org')) score += 2
	if (lower.includes('github.com') || lower.includes('arxiv.org')) score += 2
	if (lower.endsWith('.pdf')) score += 1
	if (/(pinterest|quora|reddit|instagram)\.com/.test(lower)) score -= 2
	if (/(nytimes|wsj|ft)\.com/.test(lower)) score -= 1
	return score
}

function hostnameFromUrl(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase()
	} catch {
		return null
	}
}

/**
 * Build a numbered sources block for the synthesis LLM prompt — one line per source with the
 * `[N]` citation key, title, URL, and the extracted text. Returns the block + a map from
 * citation key to source ID so the post-synthesis step can flip `cited_in_report` correctly.
 */
export function buildSourcesPromptBlock(
	sources: Pick<ResearchSourceRow, 'id' | 'title' | 'url' | 'extractedText'>[],
	maxCharsPerSource = 4000,
): { block: string; citationMap: Map<string, string> } {
	const citationMap = new Map<string, string>()
	const lines: string[] = []
	sources.forEach((src, idx) => {
		const key = `[${idx + 1}]`
		citationMap.set(key, src.id)
		const text = (src.extractedText ?? '').slice(0, maxCharsPerSource)
		lines.push(`### ${key} ${src.title ?? '(untitled)'}\nURL: ${src.url}\n\n${text}\n`)
	})
	return { block: lines.join('\n---\n'), citationMap }
}

/**
 * Find which `[N]` citation keys appear in a finished report. Used to flip
 * `cited_in_report=true` only on sources that actually contributed.
 *
 * Matches `[1]`, `[2]`, `[12]` etc. Ignores `[0]` (zero-index footnotes shouldn't exist) and
 * out-of-range keys (model hallucinated a citation past the source count).
 */
export function extractCitedSourceIds(
	report: string,
	citationMap: Map<string, string>,
): string[] {
	const matches = new Set<string>()
	const re = /\[(\d+)\]/g
	let m: RegExpExecArray | null
	while ((m = re.exec(report)) !== null) {
		const key = `[${m[1]}]`
		const id = citationMap.get(key)
		if (id) matches.add(id)
	}
	return [...matches]
}
