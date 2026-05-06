import type { ResearchSourceRow } from './research.schema'

/**
 * Wave 4 #18 phase 2 — pure helpers for the research orchestrator loop.
 *
 * Lives in its own module (no $env / db / SvelteKit deps) so unit tests can pin parser
 * + URL-selection + citation-formatting behavior without spinning up the LLM. The loop
 * itself in `research.server.ts` imports these.
 */

/**
 * Parse a JSON-shaped LLM response that should contain a string-array under `field`.
 *
 * Used by both the planner (`field: 'subQuestions'`) and the reflection step
 * (`field: 'gaps'`). Real models sometimes wrap in ```json fences or include preamble text,
 * so we try direct parse → fenced-block parse → outermost `{...}` substring → last-ditch
 * line-split fallback.
 *
 * Pure helper, no I/O — easy to unit-test.
 */
function parseJsonStringArrayField(raw: string, field: string): string[] {
	const trimmed = raw.trim()
	if (!trimmed) return []

	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
	const candidate = fenced ? fenced[1].trim() : trimmed

	// Try direct JSON parse first.
	const parsed = tryParseJsonField(candidate, field)
	if (parsed) return cleanStringArray(parsed)

	// Try outermost {...} substring.
	const start = candidate.indexOf('{')
	const end = candidate.lastIndexOf('}')
	if (start >= 0 && end > start) {
		const slice = candidate.slice(start, end + 1)
		const reparsed = tryParseJsonField(slice, field)
		if (reparsed) return cleanStringArray(reparsed)
	}

	// Last-ditch fallback: split on lines that look like numbered/bulleted entries.
	const lines = candidate
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s*/, '').trim())
		.filter((l) => l.length >= 8 && l.length < 240)
	return cleanStringArray(lines).slice(0, 5)
}

/**
 * Parse a planning LLM response into a clean array of sub-questions.
 * The planner is instructed to return JSON `{"subQuestions": ["...", "..."]}`.
 */
export function parsePlannerResponse(raw: string): string[] {
	return parseJsonStringArrayField(raw, 'subQuestions')
}

/**
 * Parse a reflection LLM response into a clean array of follow-up gap queries.
 * The reflector is instructed to return JSON `{"gaps": ["...", "..."]}`. May be empty when
 * coverage is genuinely complete.
 */
export function parseReflectionResponse(raw: string): string[] {
	// Reflection caps at 4 follow-up queries (per the prompt) but we hard-cap at 6 here as a
	// runaway-defense backstop, mirroring the planner's 8-cap.
	return parseJsonStringArrayField(raw, 'gaps').slice(0, 6)
}

function tryParseJsonField(s: string, field: string): unknown[] | null {
	try {
		const parsed = JSON.parse(s) as Record<string, unknown>
		const value = parsed?.[field]
		return Array.isArray(value) ? value : null
	} catch {
		return null
	}
}

function cleanStringArray(raw: unknown[]): string[] {
	return raw
		.filter((q): q is string => typeof q === 'string')
		.map((q) => q.trim())
		.filter((q) => q.length >= 4 && q.length < 240)
		.slice(0, 8) // hard cap so a runaway model can't generate 50 entries
}

/**
 * Bounded-concurrency mapper. Runs `fn(item)` over `items` with at most `limit` in flight at
 * any time. Returns results in input order. Pure helper — no external dep on `p-limit` so we
 * stay zero-dep for this rebuild.
 *
 * Used by the orchestrator to fan out per-sub-question search+fetch in parallel without
 * hammering SearXNG / target sites with too many concurrent requests.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const safeLimit = Math.max(1, Math.floor(limit))
	const results: R[] = new Array(items.length)
	let nextIndex = 0
	const workers = Array.from({ length: Math.min(safeLimit, items.length) }, async () => {
		while (true) {
			const i = nextIndex++
			if (i >= items.length) return
			results[i] = await fn(items[i], i)
		}
	})
	await Promise.all(workers)
	return results
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
