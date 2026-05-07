import { command, query } from '$app/server'
import { z } from 'zod'
import {
	addSkillFile,
	createSkill,
	deleteSkill,
	deleteSkillFile,
	getSkillById,
	listSkills,
	updateSkill,
	updateSkillFile,
	upsertSkillFromSource,
} from '$lib/skills/skills.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { auditSkillDeleted } from '$lib/governance'
import { parseSkillSource, serializeSkillSource } from '$lib/skills/skill-source'

/* ── Queries ────────────────────────────────────────────────── */

const listSkillsSchema = z.object({
	search: z.string().trim().min(1).optional(),
	enabled: z.boolean().optional(),
	limit: z.number().int().min(1).max(200).optional(),
})

const skillIdSchema = z.object({
	id: z.string().uuid(),
})

export const listSkillsQuery = query(listSkillsSchema, async ({ search, enabled, limit }) => {
	return listSkills({ search, enabled, limit })
})

export const getSkillByIdQuery = query(skillIdSchema, async ({ id }) => {
	return getSkillById(id)
})

/* ── Commands ───────────────────────────────────────────────── */

// PR-3 — skill category enum. Validated at the API surface; stored as nullable text in the
// DB so we can iterate without painful Postgres enum migrations.
const skillCategorySchema = z.enum(['tool', 'workflow', 'domain', 'policy', 'identity', 'hook'])

const createSkillSchema = z.object({
	name: z.string().trim().min(1).max(100),
	description: z.string().trim().min(1).max(500),
	content: z.string().trim().min(1),
	tags: z.array(z.string().trim().min(1)).optional(),
	category: skillCategorySchema.optional(),
})

const updateSkillSchema = z.object({
	id: z.string().uuid(),
	name: z.string().trim().min(1).max(100).optional(),
	description: z.string().trim().min(1).max(500).optional(),
	content: z.string().trim().min(1).optional(),
	tags: z.array(z.string().trim().min(1)).optional(),
	enabled: z.boolean().optional(),
	category: skillCategorySchema.nullable().optional(),
})

const addSkillFileSchema = z.object({
	skillId: z.string().uuid(),
	name: z.string().trim().min(1).max(200),
	description: z.string().trim().max(500).default(''),
	content: z.string().trim().min(1),
	sortOrder: z.number().int().min(0).optional(),
})

const updateSkillFileSchema = z.object({
	fileId: z.string().uuid(),
	name: z.string().trim().min(1).max(200).optional(),
	description: z.string().trim().max(500).optional(),
	content: z.string().trim().min(1).optional(),
	sortOrder: z.number().int().min(0).optional(),
})

const deleteSkillFileSchema = z.object({
	fileId: z.string().uuid(),
})

export const createSkillCommand = command(createSkillSchema, async ({ name, description, content, tags, category }) => {
	return createSkill(name, description, content, tags, category)
})

export const updateSkillCommand = command(updateSkillSchema, async ({ id, ...fields }) => {
	return updateSkill(id, fields)
})

export const deleteSkillCommand = command(skillIdSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	const before = await getSkillById(id)
	await deleteSkill(id)
	if (before) {
		void auditSkillDeleted({
			actorUserId: user.id,
			skillId: id,
			beforeState: {
				name: before.name,
				description: before.description,
				enabled: before.enabled,
				tags: before.tags,
			},
			summary: `Deleted skill "${before.name}"`,
		})
	}
	return { ok: true }
})

export const toggleSkillEnabledCommand = command(
	z.object({ id: z.string().uuid(), enabled: z.boolean() }),
	async ({ id, enabled }) => {
		return updateSkill(id, { enabled })
	},
)

export const addSkillFileCommand = command(
	addSkillFileSchema,
	async ({ skillId, name, description, content, sortOrder }) => {
		return addSkillFile(skillId, name, description, content, sortOrder)
	},
)

export const updateSkillFileCommand = command(updateSkillFileSchema, async ({ fileId, ...fields }) => {
	return updateSkillFile(fileId, fields)
})

export const deleteSkillFileCommand = command(deleteSkillFileSchema, async ({ fileId }) => {
	await deleteSkillFile(fileId)
	return { ok: true }
})

/* ── SKILL.md import / export ───────────────────────────────── */

const importSkillSchema = z.object({
	source: z.string().min(1, 'SKILL.md text cannot be empty'),
	mode: z.enum(['create', 'overwrite']).default('create'),
	resources: z
		.array(
			z.object({
				name: z.string().trim().min(1).max(200),
				description: z.string().trim().max(500).optional(),
				content: z.string().min(1),
			}),
		)
		.optional(),
})

export const importSkillCommand = command(importSkillSchema, async ({ source, mode, resources }) => {
	const parsed = parseSkillSource(source)
	const result = await upsertSkillFromSource({
		mode,
		name: parsed.frontmatter.name,
		description: parsed.frontmatter.description,
		content: parsed.body,
		category: parsed.frontmatter.category,
		tags: parsed.frontmatter.tags,
		enabled: parsed.frontmatter.enabled,
		resources,
	})
	return { id: result.id, name: parsed.frontmatter.name, created: result.created, updated: result.updated }
})

export const exportSkillCommand = command(skillIdSchema, async ({ id }) => {
	const skill = await getSkillById(id)
	if (!skill) throw new Error('Skill not found')
	const skillMd = serializeSkillSource({
		name: skill.name,
		description: skill.description,
		content: skill.content,
		tags: skill.tags,
		enabled: skill.enabled,
	})
	const resources = skill.files.map((f) => ({
		name: f.name,
		description: f.description ?? '',
		content: f.content,
	}))
	return { name: skill.name, skillMd, resources }
})

