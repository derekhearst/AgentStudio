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
 *   companion_groups: [sandbox]                  # optional — auto-injects on enable_capability
 *   companion_tools: [shell, file_patch]         # optional
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
	companionGroups?: string[]
	companionTools?: string[]
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
	companionGroups?: string[]
	companionTools?: string[]
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

	const companionGroups = readStringArray(raw, 'companion_groups') ?? readStringArray(raw, 'companionGroups')
	if (companionGroups) frontmatter.companionGroups = companionGroups

	const companionTools = readStringArray(raw, 'companion_tools') ?? readStringArray(raw, 'companionTools')
	if (companionTools) frontmatter.companionTools = companionTools

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
	if (input.companionGroups && input.companionGroups.length > 0) fm.companion_groups = input.companionGroups
	if (input.companionTools && input.companionTools.length > 0) fm.companion_tools = input.companionTools
	// Only emit `enabled` when explicitly disabled — true is the default and would just be noise.
	if (input.enabled === false) fm.enabled = false

	const head = serializeFrontmatter(fm)
	const body = input.content.trim()
	return `${head}\n\n${body}\n`
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
