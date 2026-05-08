/**
 * Slug generation for projects and artifacts.
 *
 * Pure module: `slugify` produces a URL-safe lowercase slug capped at 64 chars,
 * with empty/whitespace input falling back to `'untitled'`. Project- and
 * artifact-scoped uniqueness checks (the per-row collision-resilient
 * `-2` / `-3` suffixing) live in their respective server modules — they need
 * DB access to read the existing taken set.
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
