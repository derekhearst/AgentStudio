import { and, asc, desc, eq, ilike, or, sql, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { skillFiles, skills } from '$lib/skills/skills.schema'
import { emitActivity } from '$lib/activity/activity.server'
import { embedOne, toPgVector } from '$lib/memory/embeddings.server'
import { logger } from '$lib/observability/logger'
import {
	SYSTEM_SKILL_FILES,
	SYSTEM_SKILL_ID,
	SYSTEM_SKILL_NAME,
	buildSystemSkill,
	isSystemSkillId,
	shouldIncludeSystemSkill,
} from './skills-system.server'
import { backfillSkillEmbeddings, refreshSkillEmbedding } from './skills-embeddings.server'

// Re-export so external callers ($lib/skills/skills.server) keep working after the split.
export { backfillSkillEmbeddings, refreshSkillEmbedding } from './skills-embeddings.server'
export {
	addSkillFile,
	deleteSkillFile,
	getSkillFile,
	getSkillFileByName,
	updateSkillFile,
} from './skills-files.server'

/* ── Skills CRUD ────────────────────────────────────────────── */

export async function createSkill(
	name: string,
	description: string,
	content: string,
	tags?: string[],
	category?: string | null,
) {
	const [skill] = await db
		.insert(skills)
		.values({ name, description, content, tags: tags ?? [], category: category ?? null })
		.returning()
	void emitActivity('skill_created', `Skill created: ${name}`, {
		entityId: skill.id,
		entityType: 'skill',
	})
	void refreshSkillEmbedding(skill.id)
	return skill
}

export async function updateSkill(
	id: string,
	fields: {
		name?: string
		description?: string
		content?: string
		tags?: string[]
		enabled?: boolean
		category?: string | null
	},
) {
	if (isSystemSkillId(id)) {
		throw new Error('System skill is read-only')
	}

	const [skill] = await db
		.update(skills)
		.set({ ...fields, updatedAt: new Date() })
		.where(eq(skills.id, id))
		.returning()
	if (fields.name !== undefined || fields.description !== undefined) {
		void refreshSkillEmbedding(id)
	}
	return skill
}

export async function deleteSkill(id: string) {
	if (isSystemSkillId(id)) {
		throw new Error('System skill cannot be deleted')
	}

	await db.delete(skills).where(eq(skills.id, id))
}

/**
 * Create-or-update a skill plus its resource files from a parsed SKILL.md package. Used by
 * the import command (single-skill paste) and (later) the repo file boot loader.
 *
 * Match key: `skills.name`. When `mode: 'create'` and a row with the same name already exists,
 * throws so the UI can prompt the user to switch to overwrite mode. When `mode: 'overwrite'`,
 * updates the existing row in place — tags fully replace whatever was there. Resource files
 * are reconciled (insert new, update by name, delete missing).
 */
export async function upsertSkillFromSource(input: {
	mode: 'create' | 'overwrite'
	name: string
	description: string
	content: string
	category?: string
	tags?: string[]
	enabled?: boolean
	resources?: Array<{ name: string; description?: string; content: string }>
	sourceFile?: string
}): Promise<{ id: string; created: boolean; updated: boolean }> {
	const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, input.name)).limit(1)

	if (existing) {
		if (isSystemSkillId(existing.id)) {
			throw new Error('System skill is read-only')
		}
		if (input.mode === 'create') {
			throw new Error(`A skill named "${input.name}" already exists. Use overwrite mode to replace it.`)
		}
	}

	const baseFields = {
		name: input.name,
		description: input.description,
		content: input.content,
		tags: input.tags ?? [],
		enabled: input.enabled ?? true,
		category: input.category ?? null,
		sourceFile: input.sourceFile ?? null,
		updatedAt: new Date(),
	}

	let skillId: string
	let created = false
	let updated = false

	if (existing) {
		await db.update(skills).set(baseFields).where(eq(skills.id, existing.id))
		skillId = existing.id
		updated = true
	} else {
		const [row] = await db
			.insert(skills)
			.values({ ...baseFields })
			.returning({ id: skills.id })
		skillId = row.id
		created = true
		void emitActivity('skill_created', `Skill created from SKILL.md: ${input.name}`, {
			entityId: skillId,
			entityType: 'skill',
		})
	}

	// Reconcile resource files: insert new, update by name, delete the rest. The DB has a
	// unique (skill_id, name) constraint, so we match on filename — stable across re-imports.
	if (input.resources) {
		const incoming = input.resources
		const incomingNames = new Set(incoming.map((r) => r.name))
		const current = await db
			.select({ id: skillFiles.id, name: skillFiles.name })
			.from(skillFiles)
			.where(eq(skillFiles.skillId, skillId))
		const currentByName = new Map(current.map((c) => [c.name, c.id]))

		for (let idx = 0; idx < incoming.length; idx++) {
			const r = incoming[idx]
			const existingId = currentByName.get(r.name)
			if (existingId) {
				await db
					.update(skillFiles)
					.set({
						description: r.description ?? '',
						content: r.content,
						sortOrder: idx,
						updatedAt: new Date(),
					})
					.where(eq(skillFiles.id, existingId))
			} else {
				await db.insert(skillFiles).values({
					skillId,
					name: r.name,
					description: r.description ?? '',
					content: r.content,
					sortOrder: idx,
				})
			}
		}

		const toDelete = current.filter((c) => !incomingNames.has(c.name))
		for (const c of toDelete) {
			await db.delete(skillFiles).where(eq(skillFiles.id, c.id))
		}
	}

	void refreshSkillEmbedding(skillId)
	return { id: skillId, created, updated }
}

export async function getSkillById(id: string) {
	if (id === SYSTEM_SKILL_ID) {
		return buildSystemSkill()
	}

	const [skill] = await db.select().from(skills).where(eq(skills.id, id)).limit(1)
	if (!skill) return null
	const files = await db
		.select()
		.from(skillFiles)
		.where(eq(skillFiles.skillId, id))
		.orderBy(asc(skillFiles.sortOrder), asc(skillFiles.name))
	return { ...skill, files, isSystem: false }
}

export async function getSkillByName(name: string) {
	if (name === SYSTEM_SKILL_NAME) {
		return buildSystemSkill()
	}

	const [skill] = await db.select().from(skills).where(eq(skills.name, name)).limit(1)
	if (!skill) return null
	const files = await db
		.select()
		.from(skillFiles)
		.where(eq(skillFiles.skillId, skill.id))
		.orderBy(asc(skillFiles.sortOrder), asc(skillFiles.name))
	return { ...skill, files, isSystem: false }
}

export async function listSkills(options?: { search?: string; enabled?: boolean; limit?: number }) {
	const conditions = []
	if (options?.search) {
		conditions.push(or(ilike(skills.name, `%${options.search}%`), ilike(skills.description, `%${options.search}%`)))
	}
	if (options?.enabled !== undefined) {
		conditions.push(eq(skills.enabled, options.enabled))
	}

	const rows = await db
		.select()
		.from(skills)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(asc(skills.name))
		.limit(options?.limit ?? 100)

	// Fetch file counts per skill
	const skillIds = rows.map((r) => r.id)
	const countMap = new Map<string, number>()
	if (skillIds.length > 0) {
		const fileCounts = await db
			.select({ skillId: skillFiles.skillId, count: sql<number>`count(*)::int` })
			.from(skillFiles)
			.where(
				sql`${skillFiles.skillId} = ANY(${sql`ARRAY[${sql.join(
					skillIds.map((id) => sql`${id}::uuid`),
					sql`,`,
				)}]`})`,
			)
			.groupBy(skillFiles.skillId)

		for (const row of fileCounts) {
			countMap.set(row.skillId, row.count)
		}
	}

	const result = rows.map((skill) => ({
		...skill,
		fileCount: countMap.get(skill.id) ?? 0,
		isSystem: false,
	}))

	if (shouldIncludeSystemSkill(options)) {
		result.push(buildSystemSkill())
	}

	result.sort((a, b) => a.name.localeCompare(b.name))
	return result.slice(0, options?.limit ?? 100)
}

/**
 * Returns lightweight summaries for system prompt injection.
 * Only enabled skills are included.
 */
export async function listSkillSummaries() {
	const systemSkill = buildSystemSkill()
	const systemSummary = {
		id: systemSkill.id,
		name: systemSkill.name,
		description: systemSkill.description,
		files: systemSkill.files.map((f) => ({ name: f.name, description: f.description })),
	}

	const rows = await db
		.select({ id: skills.id, name: skills.name, description: skills.description })
		.from(skills)
		.where(eq(skills.enabled, true))
		.orderBy(asc(skills.name))

	const files = await db
		.select({ skillId: skillFiles.skillId, name: skillFiles.name, description: skillFiles.description })
		.from(skillFiles)
		.innerJoin(skills, eq(skillFiles.skillId, skills.id))
		.where(eq(skills.enabled, true))
		.orderBy(asc(skillFiles.sortOrder), asc(skillFiles.name))

	const fileMap = new Map<string, Array<{ name: string; description: string }>>()
	for (const f of files) {
		const arr = fileMap.get(f.skillId) ?? []
		arr.push({ name: f.name, description: f.description })
		fileMap.set(f.skillId, arr)
	}

	const dbSummaries = rows.map((skill) => ({
		...skill,
		files: fileMap.get(skill.id) ?? [],
	}))

	return [...dbSummaries, systemSummary].sort((a, b) => a.name.localeCompare(b.name))
}

export async function bumpSkillAccess(id: string) {
	if (id === SYSTEM_SKILL_ID) {
		return
	}

	await db
		.update(skills)
		.set({
			accessCount: sql`${skills.accessCount} + 1`,
			lastAccessed: new Date(),
		})
		.where(eq(skills.id, id))
}

/* ── Skill Files CRUD ─────── moved to skills-files.server.ts ─ */
/* ── Skill embeddings ─────── moved to skills-embeddings.server.ts ─ */

export type SkillSummary = Awaited<ReturnType<typeof listSkillSummaries>>[number]

/**
 * Return the top-K most relevant skill summaries for the given query text by cosine similarity
 * over the persisted `description_embedding` vectors.
 *
 * Skills without an embedding (newly added, not yet backfilled, or embedding API was down when
 * they were saved) are appended after the relevance-ranked set so they're never invisible.
 *
 * The built-in `agentstudio-guide` system skill is always included.
 *
 * Falls back to `listSkillSummaries()` when the query embedding fails or no skills have
 * embeddings yet — the system stays usable even if OPENROUTER_API_KEY is unset.
 */
export async function listRelevantSkillSummaries(query: string, topK = 8): Promise<SkillSummary[]> {
	const trimmed = (query ?? '').trim()
	if (!trimmed) return listSkillSummaries()

	let queryVector: number[]
	try {
		queryVector = await embedOne(trimmed)
	} catch (err) {
		logger.warn('[skills] listRelevantSkillSummaries embedding failed; falling back to all', { err })
		return listSkillSummaries()
	}

	const ranked = await db
		.select({
			id: skills.id,
			name: skills.name,
			description: skills.description,
			distance: drizzleSql<number>`${skills.descriptionEmbedding} <=> ${toPgVector(queryVector)}::vector`,
		})
		.from(skills)
		.where(and(eq(skills.enabled, true), drizzleSql`${skills.descriptionEmbedding} is not null`))
		.orderBy(drizzleSql`${skills.descriptionEmbedding} <=> ${toPgVector(queryVector)}::vector asc`)
		.limit(Math.max(1, topK))

	const rankedIds = new Set(ranked.map((r) => r.id))
	// Surface skills that haven't been embedded yet so they're never silently dropped.
	const unembedded = await db
		.select({ id: skills.id, name: skills.name, description: skills.description })
		.from(skills)
		.where(and(eq(skills.enabled, true), drizzleSql`${skills.descriptionEmbedding} is null`))

	// Always-include set: identity/hook skills are load-bearing for posture and event handling
	// — they must be in the prompt regardless of relevance score. The category column was
	// backfilled in migration 0054 from the `name` namespace; the OR clause keeps name-prefix
	// matching as a safety net for any row that hasn't been categorized yet.
	const alwaysInclude = await db
		.select({ id: skills.id, name: skills.name, description: skills.description })
		.from(skills)
		.where(
			and(
				eq(skills.enabled, true),
				drizzleSql`(${skills.category} in ('identity', 'hook') or ${skills.name} like 'system/%' or ${skills.name} like 'hook/%')`,
			),
		)
		.orderBy(asc(skills.name))

	if (ranked.length === 0 && unembedded.length === 0 && alwaysInclude.length === 0) {
		return [buildSystemSkillSummary()]
	}

	const files = await db
		.select({ skillId: skillFiles.skillId, name: skillFiles.name, description: skillFiles.description })
		.from(skillFiles)
		.innerJoin(skills, eq(skillFiles.skillId, skills.id))
		.where(eq(skills.enabled, true))
		.orderBy(asc(skillFiles.sortOrder), asc(skillFiles.name))

	const fileMap = new Map<string, Array<{ name: string; description: string }>>()
	for (const f of files) {
		const arr = fileMap.get(f.skillId) ?? []
		arr.push({ name: f.name, description: f.description })
		fileMap.set(f.skillId, arr)
	}

	const seen = new Set<string>()
	const merged: SkillSummary[] = []
	const push = (row: { id: string; name: string; description: string }) => {
		if (seen.has(row.id)) return
		seen.add(row.id)
		merged.push({ id: row.id, name: row.name, description: row.description, files: fileMap.get(row.id) ?? [] })
	}
	for (const r of ranked) push(r)
	for (const u of unembedded) {
		if (!rankedIds.has(u.id)) push(u)
	}
	for (const a of alwaysInclude) push(a)

	return [...merged, buildSystemSkillSummary()]
}

function buildSystemSkillSummary(): SkillSummary {
	const systemSkill = buildSystemSkill()
	return {
		id: systemSkill.id,
		name: systemSkill.name,
		description: systemSkill.description,
		files: systemSkill.files.map((f) => ({ name: f.name, description: f.description })),
	}
}

// Capability-group / companion-tool skill lookups removed alongside the `enable_capability`
// meta-tool. Skills are now surfaced exclusively via `listSkillSummaries` /
// `listRelevantSkillSummaries` (relevance-ranked per query).
