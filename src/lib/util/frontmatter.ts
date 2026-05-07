/**
 * Shared YAML-style frontmatter parser used by both the agents source loader (`AGENT.md`) and
 * the skills source loader (`SKILL.md`). Hand-rolled and intentionally rigid:
 *
 *   - `key: value`
 *   - `key: [a, b, c]`           inline arrays
 *   - `key:`                     followed by indented `  - item` lines (dash-list)
 *   - quoted scalars             surrounding `"…"` or `'…'` are stripped
 *
 * Unsupported (callers must avoid):
 *   - nested maps
 *   - multi-line strings
 *   - YAML anchors/aliases
 *
 * Returns `{ frontmatter: null, body: content }` when no frontmatter block is present so
 * callers can treat the whole file as the body without a special case.
 *
 * Promoted from `src/lib/agents/agent-source-loader.ts` (its original home) so the skills and
 * agents domains share one parser. Swapping in `js-yaml` later is a one-file change.
 */

const FRONTMATTER_REGEX = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/

export function extractFrontmatter(content: string): {
	frontmatter: Record<string, unknown> | null
	body: string
} {
	const match = FRONTMATTER_REGEX.exec(content)
	if (!match) {
		return { frontmatter: null, body: content }
	}
	const yamlText = match[1] ?? ''
	const body = (match[2] ?? '').replace(/^\r?\n+/, '')
	const frontmatter: Record<string, unknown> = {}
	const lines = yamlText.split(/\r?\n/)

	let i = 0
	while (i < lines.length) {
		const line = lines[i]
		if (!line.trim()) {
			i++
			continue
		}
		const kv = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(line)
		if (!kv) {
			i++
			continue
		}
		const key = kv[1]
		const rawValue = kv[2].trim()

		if (rawValue === '') {
			const items: string[] = []
			i++
			while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
				items.push(lines[i].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''))
				i++
			}
			frontmatter[key] = items
			continue
		}

		if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
			const inner = rawValue.slice(1, -1)
			frontmatter[key] = inner
				.split(',')
				.map((s) => s.trim().replace(/^["']|["']$/g, ''))
				.filter(Boolean)
		} else {
			frontmatter[key] = rawValue.replace(/^["']|["']$/g, '')
		}
		i++
	}

	return { frontmatter, body }
}

/**
 * Inverse of `extractFrontmatter`. Serializes a flat map of frontmatter values back into a
 * YAML-style block. Strings, numbers, booleans, and string arrays are supported; other shapes
 * are coerced to strings via `String(...)` (matching the parser's lenient ingest).
 *
 * Used by the skills export path to round-trip a DB row back into `SKILL.md` text.
 */
export function serializeFrontmatter(frontmatter: Record<string, unknown>): string {
	const lines: string[] = ['---']
	for (const [key, value] of Object.entries(frontmatter)) {
		if (value === undefined || value === null) continue
		if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${key}: []`)
				continue
			}
			const allSimple = value.every(
				(v) => typeof v === 'string' && !v.includes(',') && !v.includes('"') && !v.includes("'") && v.trim().length > 0,
			)
			if (allSimple) {
				lines.push(`${key}: [${(value as string[]).join(', ')}]`)
			} else {
				lines.push(`${key}:`)
				for (const item of value) {
					lines.push(`  - ${quoteIfNeeded(String(item))}`)
				}
			}
			continue
		}
		if (typeof value === 'boolean' || typeof value === 'number') {
			lines.push(`${key}: ${value}`)
			continue
		}
		lines.push(`${key}: ${quoteIfNeeded(String(value))}`)
	}
	lines.push('---')
	return lines.join('\n')
}

function quoteIfNeeded(value: string): string {
	const trimmed = value.trim()
	if (trimmed === '') return '""'
	// Quote if the value contains characters that would break YAML parsing in the inline form.
	if (/[:#,\[\]{}&*!|>'"%@`]/.test(trimmed) || /^\s/.test(value) || /\s$/.test(value)) {
		// Prefer double quotes; escape any embedded double quotes.
		return `"${trimmed.replace(/"/g, '\\"')}"`
	}
	return trimmed
}
