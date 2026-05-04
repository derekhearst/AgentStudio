/**
 * Wave 4 #18 phase 1 — pure helpers for the web_fetch tool.
 *
 * URL validation + boilerplate stripping + paragraph-boundary truncation. Lives in its own
 * module (no $env / Playwright deps) so unit tests can pin the URL safety contract without
 * spinning up a browser.
 *
 * SAFETY: web_fetch is NOT allowed to read private addresses (RFC 1918, link-local, loopback,
 * IPv6 ULA). The validator rejects them BEFORE the network call so SSRF can't leak data
 * from the orchestrator's network neighborhood.
 */

const PRIVATE_HOST_PATTERNS = [
	/^localhost$/i,
	/^127\./, // 127.0.0.0/8 loopback
	/^10\./, // 10.0.0.0/8 private
	/^192\.168\./, // 192.168.0.0/16 private
	/^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12 private
	/^169\.254\./, // 169.254.0.0/16 link-local
	/^0\./, // 0.0.0.0/8 reserved
	/^\[?::1\]?$/, // IPv6 loopback (URL parser may keep brackets)
	/^\[?fe80::/i, // IPv6 link-local
	/^\[?fc[0-9a-f]{2}::/i, // IPv6 ULA fc00::/7
	/^\[?fd[0-9a-f]{2}::/i,
	/\.internal$/i,
	/\.local$/i,
]

export type UrlValidationResult =
	| { ok: true; url: URL }
	| { ok: false; error: string }

export function validateFetchUrl(input: string): UrlValidationResult {
	let parsed: URL
	try {
		parsed = new URL(input.trim())
	} catch {
		return { ok: false, error: 'invalid URL' }
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { ok: false, error: `unsupported protocol "${parsed.protocol}" (only http/https allowed)` }
	}
	const host = parsed.hostname
	if (!host) return { ok: false, error: 'URL has no host' }
	for (const pattern of PRIVATE_HOST_PATTERNS) {
		if (pattern.test(host)) {
			return { ok: false, error: `Blocked: private/loopback address "${host}"` }
		}
	}
	return { ok: true, url: parsed }
}

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
 * Strip common boilerplate elements from raw HTML text. The Playwright fetch returns
 * `page.textContent('body')` which already drops scripts/styles, but headers/footers/nav still
 * leak through; we collapse them via line-based heuristics here.
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
