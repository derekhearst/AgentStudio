/**
 * Wave 4 #18 phase 5 — pure report-rendering helpers.
 *
 * The synthesizer LLM emits a markdown report with inline `[N]` citations referring to the
 * numbered sources block we built via `buildSourcesPromptBlock`. Rather than render the
 * report as plain `<pre>` text (which loses the links), we split it into typed parts so the
 * Svelte template can render `[N]` as anchor tags pointing at the source URL.
 *
 * Pure module (no $env / SvelteKit / Svelte deps) so unit tests can pin the parsing behavior
 * without spinning up the page render.
 */

export type ReportPart =
	| { type: 'text'; value: string }
	| { type: 'citation'; n: number; sourceId: string | null; url: string | null; title: string | null }

export type SourceForRender = {
	id: string
	url: string
	title?: string | null
}

/**
 * Split a report into text + citation parts. Citations are 1-indexed `[N]` keys; the source
 * at `sources[N-1]` is the target. Out-of-range citations (the model hallucinated `[42]` when
 * only 5 sources exist) render as a `[N]` text fragment with `sourceId=null` so the UI can
 * style them as broken links rather than crash.
 *
 * The split preserves the original report text exactly — concatenating all `text` and
 * `citation` parts (using `[N]` for the citation form) reconstructs the input.
 */
export function splitReportIntoParts(report: string, sources: SourceForRender[]): ReportPart[] {
	if (!report) return []
	const re = /\[(\d+)\]/g
	const parts: ReportPart[] = []
	let lastIndex = 0
	let match: RegExpExecArray | null
	while ((match = re.exec(report)) !== null) {
		// Push the text segment before this citation.
		if (match.index > lastIndex) {
			parts.push({ type: 'text', value: report.slice(lastIndex, match.index) })
		}
		const n = Number.parseInt(match[1], 10)
		const src = n >= 1 && n <= sources.length ? sources[n - 1] : null
		parts.push({
			type: 'citation',
			n,
			sourceId: src?.id ?? null,
			url: src?.url ?? null,
			title: src?.title ?? null,
		})
		lastIndex = match.index + match[0].length
	}
	// Tail text after the last citation.
	if (lastIndex < report.length) {
		parts.push({ type: 'text', value: report.slice(lastIndex) })
	}
	return parts
}

/**
 * Compute distinct citations actually referenced in the report (for the "Sources cited"
 * footer that pairs with the parts split). Preserves first-appearance order.
 */
export function citedSourcesInOrder(
	report: string,
	sources: SourceForRender[],
): SourceForRender[] {
	if (!report || sources.length === 0) return []
	const re = /\[(\d+)\]/g
	const seen = new Set<string>()
	const out: SourceForRender[] = []
	let match: RegExpExecArray | null
	while ((match = re.exec(report)) !== null) {
		const n = Number.parseInt(match[1], 10)
		if (n >= 1 && n <= sources.length) {
			const src = sources[n - 1]
			if (!seen.has(src.id)) {
				seen.add(src.id)
				out.push(src)
			}
		}
	}
	return out
}
