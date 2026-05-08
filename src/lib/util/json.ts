/**
 * Shared JSON parse helpers.
 *
 * Replaces three near-identical helpers that grew across domains:
 *   - chat/chat.ts → parseJsonValue (returns null on empty/error)
 *   - chat/tool-block-helpers.ts → parseJsonFallback (returns {} on error)
 *   - research/research-loop-helpers.ts → tryParseJsonField (used as part of
 *     a richer fenced-block-aware parser, which still lives in the research
 *     domain since it's research-specific)
 *
 * All variants are total functions that never throw — callers can rely on the
 * fallback behavior for malformed input.
 */

/**
 * Returns the parsed value, or `null` for empty input or parse errors.
 * The caller is responsible for narrowing the `unknown` return type.
 */
export function tryParseJson(raw: string | null | undefined): unknown {
	if (!raw || !raw.trim()) return null
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

/**
 * Returns the parsed value, or the supplied `fallback` for empty input or
 * parse errors. Useful when downstream code expects a specific shape.
 */
export function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T | unknown {
	const parsed = tryParseJson(raw)
	return parsed === null ? fallback : parsed
}

/**
 * Returns a `Record<string, unknown>` — handy for destructuring opaque metadata
 * and tool argument blobs without an extra cast site. Returns `{}` for empty
 * input, parse errors, or non-object JSON values (e.g. parsed `null` or array).
 */
export function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> {
	const parsed = tryParseJson(raw)
	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>
	}
	return {}
}
