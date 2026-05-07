import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillSource, type ParsedSkillSource, type SkillResource } from '$lib/skills/skill-source'

/**
 * PR-4 — SKILL.md repo-file discovery scanner.
 *
 * Pure file-system walker that reads `${root}/skills/<slug>/SKILL.md` and the optional
 * sibling `${root}/skills/<slug>/resources/*.md` files. Mirrors the AGENT.md scanner pattern
 * (`src/lib/agents/agent-source-loader.ts`) so operators have one mental model for
 * version-controlling agent and skill definitions.
 *
 * No DB writes here — see `skill-source-loader.server.ts` for the upsert side. Keeping the
 * file-system + parsing concerns pure lets unit tests pin the contract without a database.
 *
 * Layout:
 *
 *   skills/
 *     tools/sandbox-fs/
 *       SKILL.md              required: frontmatter + body
 *       resources/            optional: extra reference files
 *         examples.md
 *         pitfalls.md
 *
 * The slug directory may itself be namespaced (`tools/sandbox-fs/`) — we walk recursively.
 * The frontmatter `name` field is the storage key; the directory layout is purely a
 * convention for humans. A `name: tools/sandbox-fs` will round-trip whether the file lives
 * at `skills/tools/sandbox-fs/SKILL.md` or `skills/sandbox-fs/SKILL.md`.
 */

export type SkillDefinitionSource = {
	/** Absolute path to the SKILL.md file. Stored on the upserted DB row as `source_file`. */
	path: string
	parsed: ParsedSkillSource
	resources: SkillResource[]
}

export type SkillSourcesScan = {
	root: string
	skills: SkillDefinitionSource[]
}

const SKILL_FILENAME = 'SKILL.md'
const RESOURCES_DIR = 'resources'

function readSafe(path: string): string | null {
	try {
		if (!existsSync(path)) return null
		const stat = statSync(path)
		if (!stat.isFile()) return null
		return readFileSync(path, 'utf-8')
	} catch {
		return null
	}
}

function listSubdirs(path: string): string[] {
	try {
		if (!existsSync(path)) return []
		const stat = statSync(path)
		if (!stat.isDirectory()) return []
		return readdirSync(path)
			.filter((name) => {
				try {
					return statSync(join(path, name)).isDirectory()
				} catch {
					return false
				}
			})
			.sort()
	} catch {
		return []
	}
}

function listMarkdownFiles(path: string): string[] {
	try {
		if (!existsSync(path)) return []
		const stat = statSync(path)
		if (!stat.isDirectory()) return []
		return readdirSync(path)
			.filter((name) => name.endsWith('.md'))
			.filter((name) => {
				try {
					return statSync(join(path, name)).isFile()
				} catch {
					return false
				}
			})
			.sort()
	} catch {
		return []
	}
}

function loadResources(skillDir: string): SkillResource[] {
	const resourcesDir = join(skillDir, RESOURCES_DIR)
	const files = listMarkdownFiles(resourcesDir)
	const out: SkillResource[] = []
	for (const fileName of files) {
		const content = readSafe(join(resourcesDir, fileName))
		if (content === null) continue
		out.push({ name: fileName, content })
	}
	return out
}

/**
 * Walk a directory tree looking for SKILL.md files. Recurses into subdirectories so the
 * `tools/`, `workflow/`, `domain/` namespace prefix can map to nested folders without
 * forcing a flat layout.
 */
function findSkillFiles(root: string, depth = 0): string[] {
	if (depth > 6) return [] // sanity guard against deep recursion
	const out: string[] = []
	const direct = join(root, SKILL_FILENAME)
	if (readSafe(direct) !== null) {
		out.push(direct)
		// A directory containing a SKILL.md is a leaf — don't double-count nested SKILL.md
		// files (they'd be a different skill, but the parent's resources/ already takes
		// precedence).
		return out
	}
	for (const sub of listSubdirs(root)) {
		if (sub === RESOURCES_DIR) continue // resources/ is sibling content, not a slug
		out.push(...findSkillFiles(join(root, sub), depth + 1))
	}
	return out
}

/**
 * Scan a root directory for SKILL.md packages. Returns one entry per discovered skill.
 *
 * Pure — never writes to the DB. Always succeeds: parse failures (missing required
 * frontmatter, etc.) are silently dropped so a misconfigured repo file never breaks boot.
 * The DB upsert side (`applySkillSources`) reports per-file errors for operators.
 */
export function scanSkillSources(root: string): SkillSourcesScan {
	const skillsRoot = join(root, 'skills')
	if (!existsSync(skillsRoot)) {
		return { root, skills: [] }
	}

	const skillFiles = findSkillFiles(skillsRoot)
	const skills: SkillDefinitionSource[] = []

	for (const path of skillFiles) {
		const content = readSafe(path)
		if (content === null) continue
		try {
			const parsed = parseSkillSource(content)
			const skillDir = path.slice(0, path.length - SKILL_FILENAME.length - 1)
			const resources = loadResources(skillDir)
			skills.push({ path, parsed, resources })
		} catch {
			// Skip malformed SKILL.md rather than throwing — caller can detect drops by
			// comparing scan length to the file count it expected.
			continue
		}
	}

	return { root, skills }
}
