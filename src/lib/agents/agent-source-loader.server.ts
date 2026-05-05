import { eq, sql } from 'drizzle-orm'
import { agents } from '$lib/agents/agents.schema'
import { skills } from '$lib/skills/skills.schema'
import {
	ORCHESTRATOR_IDENTITY_SKILL_ID,
	ORCHESTRATOR_IDENTITY_SKILL_NAME,
} from './identity-seed.server'
import {
	resolveAgentName,
	scanAgentSources,
	type AgentDefinitionSource,
	type AgentSourcesScan,
} from './agent-source-loader'

/**
 * Wave 5 #22 phase 4 — DB side of the AGENTS.md scanner.
 *
 * `applyAgentSources(scan, priority)` reconciles a parsed `AgentSourcesScan` (from the pure
 * file walker) into the DB. Two write paths:
 *
 *   - `AGENTS.md` content → upserts the `system/orchestrator-identity` skill (same row
 *     seeded by Phase 1). Operators editing this file in their repo can override the
 *     baseline orchestrator prompt without code.
 *
 *   - `docs/agents/<slug>/AGENT.md` content → upserts an `agents` row by name. Frontmatter
 *     supplies role + model + capabilityGroups; markdown body becomes the legacy
 *     `systemPrompt` column. Operators can later promote the prompt into a skill via the
 *     `/agents/[id]/identity` editor (Phase 3); the AGENTS.md → DB sync stays compatible
 *     with that downstream flow.
 *
 * Priority modes:
 *   - `'db'` (default) — repo files only INSERT new agents + only UPDATE the orchestrator
 *     skill if it has the default seeded content (i.e. operator has not customized it). Safe
 *     for a fresh deploy that already has hand-tuned agents in the DB.
 *   - `'repo'` — repo files OVERRIDE the DB on conflict. The repo becomes system of record.
 *
 * Best-effort throughout: any single failure is logged + skipped, never thrown.
 */

import type { db as DbType } from '$lib/db.server'

type DbLike = typeof DbType

export type ApplyAgentSourcesPriority = 'repo' | 'db'

export type ApplyAgentSourcesResult = {
	orchestratorOverridden: boolean
	agentsInserted: number
	agentsUpdated: number
	agentsSkipped: number
	errors: string[]
}

const ORCHESTRATOR_OVERRIDDEN_TAG = 'identity:from-repo'

async function applyOrchestratorIdentity(
	dbInstance: DbLike,
	override: { path: string; content: string },
	priority: ApplyAgentSourcesPriority,
): Promise<{ overridden: boolean; error: string | null }> {
	try {
		const trimmed = override.content.trim()
		if (trimmed.length === 0) {
			return { overridden: false, error: null }
		}

		if (priority === 'db') {
			// In db-priority mode we never overwrite operator edits. We only seed when no row
			// exists yet (handled by the Phase 1 seeder), so here we no-op.
			return { overridden: false, error: null }
		}

		// priority === 'repo' — write the repo content to the orchestrator-identity skill.
		const now = new Date()
		const [updated] = await dbInstance
			.update(skills)
			.set({
				content: trimmed,
				updatedAt: now,
				tags: sql`(
					CASE
						WHEN ${skills.tags} @> ARRAY[${ORCHESTRATOR_OVERRIDDEN_TAG}]::text[] THEN ${skills.tags}
						ELSE array_append(${skills.tags}, ${ORCHESTRATOR_OVERRIDDEN_TAG})
					END
				)`,
			})
			.where(eq(skills.id, ORCHESTRATOR_IDENTITY_SKILL_ID))
			.returning({ id: skills.id })
		return { overridden: !!updated, error: null }
	} catch (err) {
		return { overridden: false, error: `orchestrator override failed: ${(err as Error).message}` }
	}
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
		if (source.frontmatter.capabilityGroups && source.frontmatter.capabilityGroups.length > 0) {
			nextConfig.capabilityGroups = source.frontmatter.capabilityGroups
		}

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
	let orchestratorOverridden = false
	let agentsInserted = 0
	let agentsUpdated = 0
	let agentsSkipped = 0

	if (scan.orchestratorIdentity) {
		const result = await applyOrchestratorIdentity(dbInstance, scan.orchestratorIdentity, priority)
		orchestratorOverridden = result.overridden
		if (result.error) errors.push(result.error)
	}

	for (const source of scan.agents) {
		const result = await applyAgent(dbInstance, source, priority)
		if (result.inserted) agentsInserted++
		if (result.updated) agentsUpdated++
		if (result.skipped) agentsSkipped++
		if (result.error) errors.push(result.error)
	}

	return {
		orchestratorOverridden,
		agentsInserted,
		agentsUpdated,
		agentsSkipped,
		errors,
	}
}

/**
 * Boot entry point. Returns null + logs a single line if the env vars don't request a scan,
 * so the boot path stays quiet for operators who don't use the AGENTS.md feature.
 *
 * Reads:
 *   - `AGENT_SOURCE_PATH`     — root to scan; default = `process.cwd()`. Scanner is a no-op
 *                                if no AGENTS.md and no `docs/agents/<slug>/AGENT.md` files
 *                                exist at that root, so leaving this unset is safe.
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
	if (!scan.orchestratorIdentity && scan.agents.length === 0) {
		return null
	}

	return applyAgentSources(dbInstance, scan, priority)
}

export {
	ORCHESTRATOR_IDENTITY_SKILL_ID,
	ORCHESTRATOR_IDENTITY_SKILL_NAME,
} from './identity-seed.server'
