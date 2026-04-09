import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { skillFiles, skills } from '$lib/skills/skills.schema'
import { emitActivity } from '$lib/activity/activity.server'

const SYSTEM_SKILL_ID = '00000000-0000-4000-8000-000000000042'
const SYSTEM_SKILL_NAME = 'drokbot-guide'
const SYSTEM_SKILL_CREATED_AT = new Date('2026-01-01T00:00:00.000Z')

const SYSTEM_SKILL_FILES = [
	{
		id: '00000000-0000-4000-8000-000000000043',
		name: 'quickstart.md',
		description: 'Best-practice workflow to get value quickly from DrokBot.',
		content: `# DrokBot Quickstart

## What this app is best at
- Conversational coding assistance across your local workspace
- Tool-driven task execution (files, shell, web, browser automation)
- Persistent memory and reusable skills for consistent responses
- Agent/task orchestration for larger work items

## Daily workflow
1. Open or create a chat from /chat.
2. Pick the model and reasoning effort appropriate for the task.
3. State your goal plus constraints (files, deadlines, style, no-go zones).
4. Ask for concrete outputs: code edits, tests, docs updates, and validation.
5. Review artifacts, tool calls, and diffs before finalizing.

## Prompting pattern that works
Use this format:
- Goal: what done looks like.
- Scope: exact files/routes/domains.
- Constraints: style, libraries, performance, security.
- Verification: tests/checks to run.

Example:
"Implement X in src/lib/foo and src/routes/bar, keep existing API shape, run relevant tests, and summarize risk."`,
		sortOrder: 0,
	},
	{
		id: '00000000-0000-4000-8000-000000000044',
		name: 'feature-map.md',
		description: 'High-level map of core product areas and when to use each.',
		content: `# Feature Map

## Chat
Use for interactive implementation, debugging, design iteration, and code reviews. The orchestrator chat is the primary interface.

## Skills
Use /skills to store repeatable instructions, standards, and domain playbooks.

## Memory
Use /memory for durable facts, context, and relationships that should persist between sessions.

## Agents
Use /agents to manage sub-agents and their configurations.

## Artifacts
Use /artifacts for durable outputs: docs, code snippets, diagrams, and generated assets.

## Automations
Use /automations for scheduled and recurring agent workflows (dream cycles, etc.).

## Cost
Use /cost to track usage and budgets.

## Settings
Configure defaults (model, budgets, notifications, behavior preferences) in /settings.`,
		sortOrder: 1,
	},
	{
		id: '00000000-0000-4000-8000-000000000045',
		name: 'effectiveness-playbook.md',
		description: 'Tactics for higher-quality outputs with fewer iterations.',
		content: `# Effectiveness Playbook

## Be explicit about success criteria
- Include acceptance criteria and edge cases.
- Name exact files and expected behavior changes.

## Ask for verification every time
- Request tests/checks and what was validated.
- Ask for residual risks and follow-up recommendations.

## Use staged execution for bigger changes
1. Discovery and plan
2. Implementation
3. Validation
4. Summary with risks and next steps

## Prefer deterministic edits
- Ask for minimal, targeted changes.
- Avoid broad refactors unless requested.

## Build reusable knowledge
- Promote repeated guidance into /skills.
- Save stable facts into /memory for better future context.

## Review mindset
When requesting review, prioritize bugs, regressions, and missing tests before style feedback.`,
		sortOrder: 2,
	},
] as const

function isSystemSkillId(id: string) {
	return id === SYSTEM_SKILL_ID
}

function isSystemSkillFileId(fileId: string) {
	return SYSTEM_SKILL_FILES.some((file) => file.id === fileId)
}

function buildSystemSkill() {
	return {
		id: SYSTEM_SKILL_ID,
		name: SYSTEM_SKILL_NAME,
		description: 'Built-in guide for understanding DrokBot features and using the app effectively.',
		content: 'This is a built-in, read-only onboarding skill that explains DrokBot and how to use it effectively.',
		tags: ['onboarding', 'guide', 'drokbot', 'best-practices'],
		enabled: true,
		accessCount: 0,
		lastAccessed: null,
		createdAt: SYSTEM_SKILL_CREATED_AT,
		updatedAt: SYSTEM_SKILL_CREATED_AT,
		isSystem: true,
		fileCount: SYSTEM_SKILL_FILES.length,
		files: SYSTEM_SKILL_FILES.map((file) => ({
			...file,
			skillId: SYSTEM_SKILL_ID,
			createdAt: SYSTEM_SKILL_CREATED_AT,
			updatedAt: SYSTEM_SKILL_CREATED_AT,
		})),
	}
}

function shouldIncludeSystemSkill(options?: { search?: string; enabled?: boolean }) {
	if (options?.enabled !== undefined && options.enabled !== true) return false
	if (!options?.search) return true

	const skill = buildSystemSkill()
	const q = options.search.trim().toLowerCase()
	if (!q) return true

	return (
		skill.name.toLowerCase().includes(q) ||
		skill.description.toLowerCase().includes(q) ||
		skill.tags.some((tag) => tag.toLowerCase().includes(q))
	)
}

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
	if (isSystemSkillId(id)) {
		throw new Error('System skill is read-only')
	}

	const [skill] = await db
		.update(skills)
		.set({ ...fields, updatedAt: new Date() })
		.where(eq(skills.id, id))
		.returning()
	return skill
}

export async function deleteSkill(id: string) {
	if (isSystemSkillId(id)) {
		throw new Error('System skill cannot be deleted')
	}

	await db.delete(skills).where(eq(skills.id, id))
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

/* ── Skill Files CRUD ───────────────────────────────────────── */

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
