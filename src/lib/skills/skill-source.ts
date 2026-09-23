import { extractFrontmatter, serializeFrontmatter } from '$lib/util/frontmatter'

/**
 * SKILL.md package format — pure parse/serialize helpers.
 *
 * A skill is authored as a markdown file with YAML-style frontmatter (parsed by the shared
 * `$lib/util/frontmatter` parser). Resource files sit alongside it under `resources/`. This
 * module is the canonical source-of-truth for how a skill round-trips between text and DB
 * shape — both the import command (`importSkillCommand`) and the repo file boot loader
 * (`skill-source-loader`) consume it.
 *
 *   ---
 *   name: tools/sandbox-fs                       # required, doubles as the unique slug
 *   description: How to safely inspect & edit.   # required, ≤500 chars
 *   category: tool                               # optional; lands fully in PR-3
 *   tags: [system, companion, sandbox]           # optional
 *   # (companion_groups / companion_tools removed alongside the enable_capability concept)
 *   companion_tools: [Bash, Edit]         # optional
 *   enabled: true                                # optional, defaults to true
 *   ---
 *
 *   # Body of the skill (the SKILL.md contents)
 *
 *   …
 */

export type SkillFrontmatter = {
	name: string
	description: string
	category?: string
	tags?: string[]
	enabled?: boolean
}

export type ParsedSkillSource = {
	frontmatter: SkillFrontmatter
	body: string
}

export type SkillResource = {
	name: string
	description?: string
	content: string
}

export type SkillSerializeInput = {
	name: string
	description: string
	content: string
	category?: string | null
	tags?: string[]
	enabled?: boolean
}

const VALID_CATEGORIES = new Set(['tool', 'workflow', 'domain', 'policy', 'identity', 'hook'])

/**
 * Parse a SKILL.md document into its frontmatter + body. Throws when required fields are
 * missing. Unknown frontmatter keys are dropped — the parser is lenient about extra metadata
 * but strict about the canonical fields.
 */
export function parseSkillSource(source: string): ParsedSkillSource {
	const { frontmatter: raw, body } = extractFrontmatter(source)
	if (!raw) {
		throw new Error('SKILL.md is missing the required `---` frontmatter block')
	}

	const name = readString(raw, 'name')
	if (!name) throw new Error('SKILL.md frontmatter must include `name`')
	const description = readString(raw, 'description')
	if (!description) throw new Error('SKILL.md frontmatter must include `description`')
	if (description.length > 500) {
		throw new Error('SKILL.md `description` must be ≤500 characters')
	}

	const trimmedBody = body.trim()
	if (trimmedBody.length === 0) {
		throw new Error('SKILL.md body cannot be empty (the primary instructions go here)')
	}

	const frontmatter: SkillFrontmatter = { name, description }

	const category = readString(raw, 'category')
	if (category) {
		if (!VALID_CATEGORIES.has(category)) {
			throw new Error(`SKILL.md \`category\` must be one of ${[...VALID_CATEGORIES].join(', ')}`)
		}
		frontmatter.category = category
	}

	const tags = readStringArray(raw, 'tags')
	if (tags) frontmatter.tags = tags

	const enabled = raw.enabled
	if (typeof enabled === 'boolean') frontmatter.enabled = enabled
	else if (enabled === 'true' || enabled === 'false') frontmatter.enabled = enabled === 'true'

	return { frontmatter, body: trimmedBody }
}

/**
 * Serialize a skill DB row back into a SKILL.md document. Only emits frontmatter keys that
 * have meaningful values — clean output that round-trips cleanly through `parseSkillSource`.
 */
export function serializeSkillSource(input: SkillSerializeInput): string {
	const fm: Record<string, unknown> = {
		name: input.name,
		description: input.description,
	}
	if (input.category) fm.category = input.category
	if (input.tags && input.tags.length > 0) fm.tags = input.tags
	// Only emit `enabled` when explicitly disabled — true is the default and would just be noise.
	if (input.enabled === false) fm.enabled = false

	const head = serializeFrontmatter(fm)
	const body = input.content.trim()
	return `${head}\n\n${body}\n`
}

/*
 * The export as one paste: SKILL.md followed by each resource file, fenced by a pair of
 * marker lines. HTML comments, so the text still renders as the SKILL.md it starts with.
 *
 *   <!-- skill-resource {"name":"checklist.md","description":"Release steps"} -->
 *   …the file's content, byte for byte…
 *   <!-- /skill-resource -->
 *
 * The header is JSON so a name or description needs no escaping rules of its own. It
 * replaces a `---` / `## resources/<name>` layout that import read back as body text: the
 * resource files became part of the skill's instructions, and their descriptions were lost.
 * The one thing it cannot carry is a file whose own content has a line that is exactly the
 * closing marker.
 */
const RESOURCE_START = /^<!-- skill-resource (\{.*\}) -->\r?$/
const RESOURCE_END = /^<!-- \/skill-resource -->\r?$/

export type ParsedSkillPackage = {
	/** The SKILL.md part, for `parseSkillSource`. */
	source: string
	resources: SkillResource[]
}

/** SKILL.md plus its resource files as one text — the export dialog's "Copy all". */
export function serializeSkillPackage(skillMd: string, resources: SkillResource[]): string {
	if (resources.length === 0) return skillMd
	const sections = resources.map((r) => {
		const header = JSON.stringify({ name: r.name, ...(r.description ? { description: r.description } : {}) })
		return `<!-- skill-resource ${header} -->\n${r.content}\n<!-- /skill-resource -->`
	})
	return `${skillMd.trimEnd()}\n\n${sections.join('\n\n')}\n`
}

/**
 * Split a pasted package back into its SKILL.md and resource files. Text with no resource
 * markers is a plain SKILL.md and comes back unchanged with no resources. Throws on a
 * section that is never closed or has an unreadable header, and on stray text between
 * sections — anything rather than silently dropping part of what was pasted.
 */
export function parseSkillPackage(text: string): ParsedSkillPackage {
	const lines = text.split('\n')
	const first = lines.findIndex((line) => RESOURCE_START.test(line))
	if (first === -1) return { source: text, resources: [] }

	const resources: SkillResource[] = []
	let i = first
	while (i < lines.length) {
		const line = lines[i]
		if (line.trim() === '') {
			i++
			continue
		}
		const start = RESOURCE_START.exec(line)
		if (!start) {
			throw new Error(`Unexpected text between resource files: "${line.trim().slice(0, 80)}"`)
		}
		const header = readResourceHeader(start[1])
		const end = lines.findIndex((candidate, index) => index > i && RESOURCE_END.test(candidate))
		if (end === -1) throw new Error(`Resource file "${header.name}" is missing its closing <!-- /skill-resource --> line`)
		resources.push({ ...header, content: lines.slice(i + 1, end).join('\n') })
		i = end + 1
	}

	return { source: lines.slice(0, first).join('\n'), resources }
}

function readResourceHeader(json: string): { name: string; description?: string } {
	let raw: unknown
	try {
		raw = JSON.parse(json)
	} catch {
		throw new Error(`Unreadable resource header: ${json.slice(0, 80)}`)
	}
	const { name, description } = (raw ?? {}) as { name?: unknown; description?: unknown }
	if (typeof name !== 'string' || name.trim().length === 0) {
		throw new Error(`Resource header has no name: ${json.slice(0, 80)}`)
	}
	return { name, ...(typeof description === 'string' && description.length > 0 ? { description } : {}) }
}

function readString(raw: Record<string, unknown>, key: string): string | undefined {
	const v = raw[key]
	if (typeof v !== 'string') return undefined
	const trimmed = v.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

function readStringArray(raw: Record<string, unknown>, key: string): string[] | undefined {
	const v = raw[key]
	if (!Array.isArray(v)) return undefined
	const cleaned = v
		.filter((x): x is string => typeof x === 'string')
		.map((x) => x.trim())
		.filter((x) => x.length > 0)
	return cleaned.length > 0 ? cleaned : undefined
}
