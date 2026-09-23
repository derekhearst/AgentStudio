/**
 * Shared YAML-style frontmatter parser used by both the agents source loader (`AGENT.md`) and
 * the skills source loader (`SKILL.md`). Hand-rolled and intentionally rigid:
 *
 *   - `key: value`
 *   - `key: [a, b, c]`           inline arrays
 *   - `key:`                     followed by indented `  - item` lines (dash-list)
 *   - quoted scalars             surrounding `"…"` or `'…'` are stripped; inside double
 *                                quotes `\"`, `\\`, `\n`, `\r` and `\t` are unescaped, and
 *                                inside single quotes `''` is one `'` (YAML's own rules)
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
				items.push(unquoteScalar(lines[i].replace(/^\s*-\s+/, '').trim()))
				i++
			}
			frontmatter[key] = items
			continue
		}

		if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
			const inner = rawValue.slice(1, -1)
			frontmatter[key] = inner
				.split(',')
				.map((s) => unquoteScalar(s.trim()))
				.filter(Boolean)
		} else {
			frontmatter[key] = unquoteScalar(rawValue)
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

/** Escapes inside a double-quoted scalar, both ways. A backslash must be escaped first. */
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' }

/**
 * A scalar as written → its value. Double quotes are unescaped and single quotes undoubled,
 * the way YAML reads them. Only the outer quotes used to be stripped, so an exported value
 * with an embedded `"` came back as `\"` and gained another backslash on every export and
 * re-import.
 */
function unquoteScalar(raw: string): string {
	if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
		return raw.slice(1, -1).replace(/\\(["\\nrt])/g, (_, c: string) => DOUBLE_QUOTE_ESCAPES[c])
	}
	if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
		return raw.slice(1, -1).replace(/''/g, "'")
	}
	// Lenient, as before: a stray quote at either end is dropped.
	return raw.replace(/^["']|["']$/g, '')
}

function quoteIfNeeded(value: string): string {
	const trimmed = value.trim()
	if (trimmed === '') return '""'
	// Quote if the value contains characters that would break YAML parsing in the inline form,
	// or a line break, which a plain scalar cannot hold at all.
	if (/[:#,\[\]{}&*!|>'"%@`\n\r\t]/.test(trimmed) || /^\s/.test(value) || /\s$/.test(value)) {
		// Double quotes, escaped the way `unquoteScalar` reads them back.
		const escaped = trimmed
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(/\n/g, '\\n')
			.replace(/\r/g, '\\r')
			.replace(/\t/g, '\\t')
		return `"${escaped}"`
	}
	return trimmed
}
