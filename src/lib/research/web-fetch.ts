/**
 * Wave 4 #18 phase 1 — pure helpers for the web_fetch tool.
 *
 * Boilerplate stripping + paragraph-boundary truncation. Lives in its own module (no $env /
 * Playwright deps) so unit tests can pin the cleanup behaviour without spinning up a browser.
 *
 * SAFETY: the URL rule — public internet only, no loopback, LAN, link-local, ULA, CGNAT or
 * metadata addresses — lives in `$lib/tools/egress-policy`, and is enforced on every resolved
 * address and redirect hop by `$lib/tools/egress.server`. `validateFetchUrl` is kept here as
 * an alias so existing callers and specs keep working; it is only the shape check, never
 * enough on its own to decide a request is safe to send.
 */

export { validateEgressUrl as validateFetchUrl, type EgressCheck as UrlValidationResult } from '$lib/tools/egress-policy'

const DEFAULT_MAX_CHARS = 50_000

/**
 * Truncate text to `maxChars` at a paragraph boundary (double newline) so the model doesn't
 * see a half-sentence at the cut. Falls back to a hard slice when no boundary exists.
 */
export function truncateAtParagraph(text: string, maxChars: number = DEFAULT_MAX_CHARS): string {
	if (text.length <= maxChars) return text
	const slice = text.slice(0, maxChars)
	const lastBoundary = slice.lastIndexOf('\n\n')
	// Only use the boundary if it's reasonably close to the cap (within 25% of it) — otherwise
	// the truncation is too aggressive and we lose useful trailing content.
	if (lastBoundary > maxChars * 0.75) {
		return `${slice.slice(0, lastBoundary).trim()}\n\n[…truncated at paragraph boundary, ${text.length - lastBoundary} chars dropped]`
	}
	return `${slice}\n\n[…truncated at ${maxChars} chars, ${text.length - maxChars} chars dropped]`
}

/**
 * Strip common boilerplate elements from raw HTML text. The Playwright fetch returns the
 * start of the body's `textContent` (`readPageText`, cut to size inside the browser), which
 * already drops markup, but headers/footers/nav still leak through; we collapse them via
 * line-based heuristics here.
 *
 * Pure string transformation so tests can pin the cleanup behavior.
 */
export function cleanupExtractedText(raw: string): string {
	// Collapse runs of >2 newlines into exactly 2 (paragraph break).
	const collapsedNewlines = raw.replace(/\n{3,}/g, '\n\n')
	// Trim each line + drop empty whitespace lines.
	const lines = collapsedNewlines
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0 || l === '')
	// Drop short repeated nav-style lines (≤ 24 chars) that appear back-to-back.
	const filtered: string[] = []
	let prev = ''
	for (const line of lines) {
		if (line.length <= 24 && line === prev) continue
		filtered.push(line)
		prev = line
	}
	return filtered.join('\n').trim()
}
