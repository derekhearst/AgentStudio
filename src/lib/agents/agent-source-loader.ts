import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { extractFrontmatter as sharedExtractFrontmatter } from '$lib/util/frontmatter'

/**
 * Wave 5 #22 phase 4 — AGENTS.md repo-file discovery scanner.
 *
 * Pure file-system walker + YAML frontmatter parser. Reads two source paths under a configured
 * root directory (default = `process.cwd()`):
 *
 *   - `${root}/AGENTS.md`                          → orchestrator identity override
 *   - `${root}/docs/agents/<slug>/AGENT.md`        → individual agent definition
 *
 * The `docs/agents/<slug>/` shape (per the plan, vs. raw `docs/agents/`) intentionally avoids
 * conflicting with AgentStudio's own `docs/agents/{plan,spec}.md` — those live at the docs/agents/
 * top level, not in subdirectories, so a fresh AgentStudio repo scans clean.
 *
 * No DB writes here — see `agent-source-loader.server.ts` for the upsert side. Keeping the
 * file-system + parsing concerns pure lets unit tests pin the contract without a database.
 *
 * Frontmatter parsing was promoted to `src/lib/util/frontmatter.ts` so the skills source
 * loader can share the same parser. `extractFrontmatter` is re-exported here for backwards
 * compatibility with existing tests that import from this module.
 */

export type AgentSourceFrontmatter = {
	name?: string
	role?: string
	model?: string
	capabilityGroups?: string[]
}

export type AgentDefinitionSource = {
	slug: string // directory name under docs/agents/
	path: string // absolute path to AGENT.md
	frontmatter: AgentSourceFrontmatter
	systemPrompt: string // markdown body (everything after the frontmatter)
}

export type AgentSourcesScan = {
	root: string
	orchestratorIdentity: { path: string; content: string } | null
	agents: AgentDefinitionSource[]
}

/**
 * Parse the YAML-style frontmatter block at the top of a markdown file.
 *
 * Re-exports `extractFrontmatter` from `$lib/util/frontmatter`. Kept as a named export here so
 * existing callers + tests (`agents.source-loader.spec.ts`) continue to import from this
 * module without churn. New callers should import directly from `$lib/util/frontmatter`.
 */
export const extractFrontmatter = sharedExtractFrontmatter

function coerceFrontmatter(raw: Record<string, unknown> | null): AgentSourceFrontmatter {
	if (!raw) return {}
	const out: AgentSourceFrontmatter = {}
	if (typeof raw.name === 'string' && raw.name.trim().length > 0) out.name = raw.name.trim()
	if (typeof raw.role === 'string' && raw.role.trim().length > 0) out.role = raw.role.trim()
	if (typeof raw.model === 'string' && raw.model.trim().length > 0) out.model = raw.model.trim()
	if (Array.isArray(raw.capabilityGroups)) {
		out.capabilityGroups = raw.capabilityGroups
			.filter((v): v is string => typeof v === 'string')
			.map((v) => v.trim())
			.filter((v) => v.length > 0)
	}
	return out
}

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

function listAgentSlugDirs(agentsRoot: string): string[] {
	try {
		if (!existsSync(agentsRoot)) return []
		const stat = statSync(agentsRoot)
		if (!stat.isDirectory()) return []
		return readdirSync(agentsRoot)
			.filter((name) => {
				try {
					return statSync(join(agentsRoot, name)).isDirectory()
				} catch {
					return false
				}
			})
			.sort()
	} catch {
		return []
	}
}

/**
 * Scan a root directory for agent source files. Returns the parsed orchestrator identity
 * (if `${root}/AGENTS.md` exists) and a list of per-agent definitions (each at
 * `${root}/docs/agents/<slug>/AGENT.md`).
 *
 * Pure — never writes to the DB. Always succeeds (returns an empty result on missing
 * files / unreadable directories) so a misconfigured deployment never breaks boot.
 */
export function scanAgentSources(root: string): AgentSourcesScan {
	const orchestratorPath = join(root, 'AGENTS.md')
	const orchestratorContent = readSafe(orchestratorPath)

	const agentsRoot = join(root, 'docs', 'agents')
	const slugs = listAgentSlugDirs(agentsRoot)

	const agents: AgentDefinitionSource[] = []
	for (const slug of slugs) {
		const agentPath = join(agentsRoot, slug, 'AGENT.md')
		const content = readSafe(agentPath)
		if (content === null) continue
		const { frontmatter, body } = extractFrontmatter(content)
		agents.push({
			slug,
			path: agentPath,
			frontmatter: coerceFrontmatter(frontmatter),
			systemPrompt: body.trim(),
		})
	}

	return {
		root,
		orchestratorIdentity: orchestratorContent ? { path: orchestratorPath, content: orchestratorContent } : null,
		agents,
	}
}

/**
 * Resolve the agent name to use when matching/upserting. Frontmatter `name` wins; falls back
 * to the directory slug (kebab-case → Title Case) so a folder-only definition still produces
 * a sensible record name without forcing operators to repeat themselves.
 */
export function resolveAgentName(source: AgentDefinitionSource): string {
	if (source.frontmatter.name) return source.frontmatter.name
	return source.slug
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ')
}
