import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { skillFiles, skills } from '$lib/skills/skills.schema'
import { emitActivity } from '$lib/activity/activity.server'

/* ── Skills CRUD ────────────────────────────────────────────── */

export async function createSkill(name: string, description: string, content: string, tags?: string[]) {
	const [skill] = await db
		.insert(skills)
		.values({ name, description, content, tags: tags ?? [] })
		.returning()
	void emitActivity('skill_created', `Skill created: ${name}`, {
		entityId: skill.id,
		entityType: 'skill',
	})
	return skill
}

export async function updateSkill(
	id: string,
	fields: { name?: string; description?: string; content?: string; tags?: string[]; enabled?: boolean },
) {
	const [skill] = await db
		.update(skills)
		.set({ ...fields, updatedAt: new Date() })
		.where(eq(skills.id, id))
		.returning()
	return skill
}

export async function deleteSkill(id: string) {
	await db.delete(skills).where(eq(skills.id, id))
}

export async function getSkillById(id: string) {
	const [skill] = await db.select().from(skills).where(eq(skills.id, id)).limit(1)
	if (!skill) return null
	const files = await db
		.select()
		.from(skillFiles)
		.where(eq(skillFiles.skillId, id))
		.orderBy(asc(skillFiles.sortOrder), asc(skillFiles.name))
	return { ...skill, files }
}

export async function getSkillByName(name: string) {
	const [skill] = await db.select().from(skills).where(eq(skills.name, name)).limit(1)
	if (!skill) return null
	const files = await db
		.select()
		.from(skillFiles)
		.where(eq(skillFiles.skillId, skill.id))
		.orderBy(asc(skillFiles.sortOrder), asc(skillFiles.name))
	return { ...skill, files }
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
	if (skillIds.length === 0) return []

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

	const countMap = new Map(fileCounts.map((r) => [r.skillId, r.count]))

	return rows.map((skill) => ({
		...skill,
		fileCount: countMap.get(skill.id) ?? 0,
	}))
}

/**
 * Returns lightweight summaries for system prompt injection.
 * Only enabled skills are included.
 */
export async function listSkillSummaries() {
	const rows = await db
		.select({ id: skills.id, name: skills.name, description: skills.description })
		.from(skills)
		.where(eq(skills.enabled, true))
		.orderBy(asc(skills.name))

	if (rows.length === 0) return []

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

	return rows.map((skill) => ({
		...skill,
		files: fileMap.get(skill.id) ?? [],
	}))
}

export async function bumpSkillAccess(id: string) {
	await db
		.update(skills)
		.set({
			accessCount: sql`${skills.accessCount} + 1`,
			lastAccessed: new Date(),
		})
		.where(eq(skills.id, id))
}

/* ── Skill Files CRUD ───────────────────────────────────────── */

export async function addSkillFile(
	skillId: string,
	name: string,
	description: string,
	content: string,
	sortOrder?: number,
) {
	const [file] = await db
		.insert(skillFiles)
		.values({ skillId, name, description, content, sortOrder: sortOrder ?? 0 })
		.returning()
	return file
}

export async function updateSkillFile(
	fileId: string,
	fields: { name?: string; description?: string; content?: string; sortOrder?: number },
) {
	const [file] = await db
		.update(skillFiles)
		.set({ ...fields, updatedAt: new Date() })
		.where(eq(skillFiles.id, fileId))
		.returning()
	return file
}

export async function deleteSkillFile(fileId: string) {
	await db.delete(skillFiles).where(eq(skillFiles.id, fileId))
}

export async function getSkillFile(fileId: string) {
	const [file] = await db.select().from(skillFiles).where(eq(skillFiles.id, fileId)).limit(1)
	return file ?? null
}

export async function getSkillFileByName(skillId: string, fileName: string) {
	const [file] = await db
		.select()
		.from(skillFiles)
		.where(and(eq(skillFiles.skillId, skillId), eq(skillFiles.name, fileName)))
		.limit(1)
	return file ?? null
}

