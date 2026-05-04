/**
 * Wave 5 #22 phase 5 — prompt fragment library via `@import`.
 *
 * Pure helper (no DB / SvelteKit deps so unit tests can pin the contract). Walks lines of
 * an identity-skill content blob, replacing standalone `@import skill-name` lines with the
 * referenced skill's content. Recursive but bounded by depth + cycle detection.
 *
 * Syntax (intentionally rigid to avoid false positives in regular markdown):
 *   - Must be a line whose only non-whitespace content is `@import <skill-name>`
 *   - skill-name pattern: alphanumeric + `-` + `_` + `/` (matches the skill naming convention)
 *   - Inline `@import` (mid-paragraph) is NOT expanded — markdown often discusses imports
 *
 * On unresolved imports the line is replaced with a warning marker so reviewers can spot
 * the breakage in the assembled prompt without the whole assembly failing.
 */

const IMPORT_LINE_REGEX = /^\s*@import\s+([a-zA-Z0-9_/\-]+)\s*$/

const DEFAULT_MAX_DEPTH = 3

export type FragmentLookup = (name: string) => string | null | undefined | Promise<string | null | undefined>

export type ExpandFragmentsOptions = {
	maxDepth?: number
}

/**
 * Expand `@import skill-name` directives in the supplied text. Returns the expanded
 * content. Cycles + depth overflow yield a `<!-- @import:cycle -->` marker so the assembled
 * prompt visibly shows the cut-off without throwing.
 */
export async function expandFragments(
	text: string,
	lookup: FragmentLookup,
	options?: ExpandFragmentsOptions,
): Promise<string> {
	const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH
	return expand(text, lookup, maxDepth, new Set<string>())
}

async function expand(
	text: string,
	lookup: FragmentLookup,
	depthRemaining: number,
	stack: Set<string>,
): Promise<string> {
	const lines = text.split(/\r?\n/)
	const out: string[] = []
	for (const line of lines) {
		const match = IMPORT_LINE_REGEX.exec(line)
		if (!match) {
			out.push(line)
			continue
		}
		const name = match[1]
		if (stack.has(name)) {
			out.push(`<!-- @import:cycle ${name} -->`)
			continue
		}
		if (depthRemaining <= 0) {
			out.push(`<!-- @import:depth-exceeded ${name} -->`)
			continue
		}
		const fragment = await lookup(name)
		if (fragment == null || fragment.length === 0) {
			out.push(`<!-- @import:missing ${name} -->`)
			continue
		}
		const nextStack = new Set(stack)
		nextStack.add(name)
		const expanded = await expand(fragment, lookup, depthRemaining - 1, nextStack)
		out.push(expanded)
	}
	return out.join('\n')
}

/**
 * Pure helper to extract referenced skill names from a piece of content WITHOUT loading
 * any of them. Useful for the editor UI's "imports preview" panel.
 */
export function listFragmentImports(text: string): string[] {
	const names: string[] = []
	for (const line of text.split(/\r?\n/)) {
		const m = IMPORT_LINE_REGEX.exec(line)
		if (m) names.push(m[1])
	}
	return [...new Set(names)]
}
