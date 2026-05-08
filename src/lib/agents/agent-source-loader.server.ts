import { eq, sql } from 'drizzle-orm'
import { agents } from '$lib/agents/agents.schema'
import {
	resolveAgentName,
	scanAgentSources,
	type AgentDefinitionSource,
	type AgentSourcesScan,
} from './agent-source-loader'
import type { db as DbType } from '$lib/db.server'

/**
 * DB side of the AGENTS.md scanner.
 *
 * `applyAgentSources(scan, priority)` reconciles a parsed `AgentSourcesScan` (from the pure
 * file walker) into the `agents` table:
 *
 *   - `docs/agents/<slug>/AGENT.md` content → upserts an `agents` row by `config.sourceSlug`.
 *     Frontmatter supplies role + model; markdown body becomes the `systemPrompt` column.
 *
 * Top-level AGENTS.md content is intentionally ignored — orchestrator identity now lives in
 * the in-code `ORCHESTRATOR_IDENTITY_DEFAULT` constant ([orchestrator.ts](./orchestrator.ts)),
 * not a DB skill row.
 *
 * Priority modes:
 *   - `'db'` (default) — repo files only INSERT new agents. Safe for fresh deploys.
 *   - `'repo'` — repo files OVERRIDE the DB on conflict. The repo becomes system of record.
 *
 * Best-effort throughout: any single failure is logged + skipped, never thrown.
 */

type DbLike = typeof DbType

export type ApplyAgentSourcesPriority = 'repo' | 'db'

export type ApplyAgentSourcesResult = {
	agentsInserted: number
	agentsUpdated: number
	agentsSkipped: number
	errors: string[]
}

async function applyAgent(
	dbInstance: DbLike,
	source: AgentDefinitionSource,
	priority: ApplyAgentSourcesPriority,
): Promise<{ inserted: boolean; updated: boolean; skipped: boolean; error: string | null }> {
	try {
		const name = resolveAgentName(source)
		const role = source.frontmatter.role?.trim()
		if (!role) {
			return {
				inserted: false,
				updated: false,
				skipped: true,
				error: `${source.path}: missing required "role" frontmatter`,
			}
		}
		if (source.systemPrompt.trim().length === 0) {
			return {
				inserted: false,
				updated: false,
				skipped: true,
				error: `${source.path}: empty body — system prompt cannot be empty`,
			}
		}

		// Match on config.sourceSlug — stable across `name` renames in frontmatter, and
		// avoids accidentally claiming a hand-created agent that happens to share a name.
		// First-time seeds insert a fresh row carrying sourceSlug forward.
		const [existing] = await dbInstance
			.select({ id: agents.id, name: agents.name, config: agents.config })
			.from(agents)
			.where(sql`${agents.config}->>'sourceSlug' = ${source.slug}`)
			.limit(1)

		const baseConfig: Record<string, unknown> = (existing?.config as Record<string, unknown> | undefined) ?? {}
		const nextConfig: Record<string, unknown> = { ...baseConfig, sourceSlug: source.slug }
		// Tool Search Tool replaces capability groups; drop the legacy field if it was set on
		// the existing row by an older version of this loader.
		delete nextConfig.capabilityGroups

		if (existing) {
			if (priority === 'db') {
				return { inserted: false, updated: false, skipped: true, error: null }
			}
			const updates: Partial<typeof agents.$inferInsert> = {
				name,
				role,
				systemPrompt: source.systemPrompt,
			}
			if (source.frontmatter.model) updates.model = source.frontmatter.model
			updates.config = nextConfig
			await dbInstance.update(agents).set(updates).where(eq(agents.id, existing.id))
			return { inserted: false, updated: true, skipped: false, error: null }
		}

		await dbInstance.insert(agents).values({
			name,
			role,
			systemPrompt: source.systemPrompt,
			model: source.frontmatter.model ?? 'anthropic/claude-sonnet-4',
			config: nextConfig,
		})
		return { inserted: true, updated: false, skipped: false, error: null }
	} catch (err) {
		return {
			inserted: false,
			updated: false,
			skipped: true,
			error: `${source.path}: ${(err as Error).message}`,
		}
	}
}

export async function applyAgentSources(
	dbInstance: DbLike,
	scan: AgentSourcesScan,
	priority: ApplyAgentSourcesPriority = 'db',
): Promise<ApplyAgentSourcesResult> {
	const errors: string[] = []
	let agentsInserted = 0
	let agentsUpdated = 0
	let agentsSkipped = 0

	for (const source of scan.agents) {
		const result = await applyAgent(dbInstance, source, priority)
		if (result.inserted) agentsInserted++
		if (result.updated) agentsUpdated++
		if (result.skipped) agentsSkipped++
		if (result.error) errors.push(result.error)
	}

	return {
		agentsInserted,
		agentsUpdated,
		agentsSkipped,
		errors,
	}
}

/**
 * Boot entry point. Returns null when no AGENT.md files exist, so the boot path stays
 * quiet for operators who don't use the AGENTS.md feature.
 *
 * Reads:
 *   - `AGENT_SOURCE_PATH`     — root to scan; default = `process.cwd()`. Scanner is a no-op
 *                                if no `docs/agents/<slug>/AGENT.md` files exist at that root,
 *                                so leaving this unset is safe.
 *   - `AGENT_SOURCE_PRIORITY` — `'repo' | 'db'`; default `'db'` (repo only inserts new agents,
 *                                never overwrites operator edits).
 */
export async function loadAgentSourcesAtBoot(
	dbInstance: DbLike,
): Promise<ApplyAgentSourcesResult | null> {
	const root = process.env.AGENT_SOURCE_PATH || process.cwd()
	const priorityEnv = process.env.AGENT_SOURCE_PRIORITY
	const priority: ApplyAgentSourcesPriority = priorityEnv === 'repo' ? 'repo' : 'db'

	const scan = scanAgentSources(root)
	if (scan.agents.length === 0) {
		return null
	}

	return applyAgentSources(dbInstance, scan, priority)
}
