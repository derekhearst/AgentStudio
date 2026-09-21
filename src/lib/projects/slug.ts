/**
 * Slug generation for projects.
 *
 * Pure module: `slugify` produces a URL-safe lowercase slug capped at 64 chars,
 * with empty/whitespace input falling back to `'untitled'`. The per-row
 * collision-resilient `-2` / `-3` suffixing lives in the projects server module
 * — it needs DB access to read the existing taken set.
 */

const SLUG_SAFE_CHARS = /[^a-z0-9-]/g
const MULTI_DASH = /-+/g

export function slugify(input: string): string {
	const base = input
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, '-')
		.replace(SLUG_SAFE_CHARS, '')
		.replace(MULTI_DASH, '-')
		.replace(/^-+|-+$/g, '')
	return base.length > 0 ? base.slice(0, 64) : 'untitled'
}
