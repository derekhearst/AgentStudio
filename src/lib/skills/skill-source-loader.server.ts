import { eq } from 'drizzle-orm'
import { skills } from '$lib/skills/skills.schema'
import { upsertSkillFromSource } from '$lib/skills/skills.server'
import { scanSkillSources, type SkillSourcesScan } from '$lib/skills/skill-source-loader'
import type { db as DbType } from '$lib/db.server'

/**
 * PR-4 — DB side of the SKILL.md scanner.
 *
 * `applySkillSources(scan, priority)` reconciles a parsed `SkillSourcesScan` (from the pure
 * file walker) into the DB. Mirrors the AGENT.md scanner contract:
 *
 *   - `'db'` (default) — repo files only INSERT new skills. Operators with hand-tuned skills
 *     in the DB are not touched.
 *   - `'repo'` — repo files OVERRIDE the DB on conflict. The repo becomes system of record;
 *     the matching `skills.source_file` is set so the next boot can detect divergence.
 *
 * Best-effort throughout: a single bad SKILL.md is logged + skipped, never thrown. The skill
 * row is matched on `name` (the unique storage key); resource files are reconciled by name
 * within the skill (insert new, update by name, delete missing).
 */

type DbLike = typeof DbType

export type ApplySkillSourcesPriority = 'repo' | 'db'

export type ApplySkillSourcesResult = {
	inserted: number
	updated: number
	skipped: number
	errors: string[]
}

async function applyOneSkill(
	dbInstance: DbLike,
	source: SkillSourcesScan['skills'][number],
	priority: ApplySkillSourcesPriority,
): Promise<{ inserted: boolean; updated: boolean; skipped: boolean; error: string | null }> {
	try {
		const fm = source.parsed.frontmatter
		const [existing] = await dbInstance
			.select({ id: skills.id, sourceFile: skills.sourceFile })
			.from(skills)
			.where(eq(skills.name, fm.name))
			.limit(1)

		if (existing && priority === 'db') {
			// db priority: never overwrite. But if the existing row has no source_file yet and we
			// found one matching its name on disk, tag it so a future repo-priority sync can act.
			if (!existing.sourceFile) {
				await dbInstance
					.update(skills)
					.set({ sourceFile: source.path })
					.where(eq(skills.id, existing.id))
			}
			return { inserted: false, updated: false, skipped: true, error: null }
		}

		const result = await upsertSkillFromSource({
			mode: existing ? 'overwrite' : 'create',
			name: fm.name,
			description: fm.description,
			content: source.parsed.body,
			category: fm.category,
			tags: fm.tags,
			companionGroups: fm.companionGroups,
			companionTools: fm.companionTools,
			enabled: fm.enabled,
			resources: source.resources,
			sourceFile: source.path,
		})

		return {
			inserted: result.created,
			updated: result.updated,
			skipped: false,
			error: null,
		}
	} catch (err) {
		return {
			inserted: false,
			updated: false,
			skipped: true,
			error: `${source.path}: ${(err as Error).message}`,
		}
	}
}

export async function applySkillSources(
	dbInstance: DbLike,
	scan: SkillSourcesScan,
	priority: ApplySkillSourcesPriority = 'db',
): Promise<ApplySkillSourcesResult> {
	const errors: string[] = []
	let inserted = 0
	let updated = 0
	let skipped = 0

	for (const source of scan.skills) {
		const result = await applyOneSkill(dbInstance, source, priority)
		if (result.inserted) inserted++
		if (result.updated) updated++
		if (result.skipped) skipped++
		if (result.error) errors.push(result.error)
	}

	return { inserted, updated, skipped, errors }
}

/**
 * Boot entry point. Returns null when no SKILL.md files are present so the boot path stays
 * quiet for operators who don't use repo-file authoring.
 *
 * Reads:
 *   - `SKILL_SOURCE_PATH`     — root to scan; default = `process.cwd()`. The scanner is a
 *                                no-op when no `skills/<slug>/SKILL.md` files exist, so
 *                                leaving this unset is safe.
 *   - `SKILL_SOURCE_PRIORITY` — `'repo' | 'db'`; default `'db'` (repo only inserts new skills,
 *                                never overwrites operator edits).
 */
export async function loadSkillSourcesAtBoot(
	dbInstance: DbLike,
): Promise<ApplySkillSourcesResult | null> {
	const root = process.env.SKILL_SOURCE_PATH || process.cwd()
	const priorityEnv = process.env.SKILL_SOURCE_PRIORITY
	const priority: ApplySkillSourcesPriority = priorityEnv === 'repo' ? 'repo' : 'db'

	const scan = scanSkillSources(root)
	if (scan.skills.length === 0) {
		return null
	}

	return applySkillSources(dbInstance, scan, priority)
}
