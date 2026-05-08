/**
 * Skill file CRUD.
 *
 * A skill is a parent row + 0+ files. The files carry the actual prompt content
 * the LLM reads — the parent skill is just naming/categorization. CRUD here
 * respects the system-skill read-only flag (built-in `agentstudio-guide`
 * cannot be edited or deleted).
 */

import { and, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { skillFiles } from '$lib/skills/skills.schema'
import {
	SYSTEM_SKILL_CREATED_AT,
	SYSTEM_SKILL_FILES,
	SYSTEM_SKILL_ID,
	isSystemSkillFileId,
	isSystemSkillId,
} from './skills-system.server'

export async function addSkillFile(
	skillId: string,
	name: string,
	description: string,
	content: string,
	sortOrder?: number,
) {
	if (isSystemSkillId(skillId)) {
		throw new Error('System skill is read-only')
	}

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
	if (isSystemSkillFileId(fileId)) {
		throw new Error('System skill file is read-only')
	}

	const [file] = await db
		.update(skillFiles)
		.set({ ...fields, updatedAt: new Date() })
		.where(eq(skillFiles.id, fileId))
		.returning()
	return file
}

export async function deleteSkillFile(fileId: string) {
	if (isSystemSkillFileId(fileId)) {
		throw new Error('System skill file cannot be deleted')
	}

	await db.delete(skillFiles).where(eq(skillFiles.id, fileId))
}

export async function getSkillFile(fileId: string) {
	const [file] = await db.select().from(skillFiles).where(eq(skillFiles.id, fileId)).limit(1)
	return file ?? null
}

export async function getSkillFileByName(skillId: string, fileName: string) {
	if (skillId === SYSTEM_SKILL_ID) {
		const match = SYSTEM_SKILL_FILES.find((file) => file.name === fileName)
		if (!match) return null
		return {
			...match,
			skillId,
			createdAt: SYSTEM_SKILL_CREATED_AT,
			updatedAt: SYSTEM_SKILL_CREATED_AT,
		}
	}

	const [file] = await db
		.select()
		.from(skillFiles)
		.where(and(eq(skillFiles.skillId, skillId), eq(skillFiles.name, fileName)))
		.limit(1)
	return file ?? null
}
