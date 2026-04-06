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
} from '$lib/skills/skills.server'

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

const createSkillSchema = z.object({
	name: z.string().trim().min(1).max(100),
	description: z.string().trim().min(1).max(500),
	content: z.string().trim().min(1),
	tags: z.array(z.string().trim().min(1)).optional(),
})

const updateSkillSchema = z.object({
	id: z.string().uuid(),
	name: z.string().trim().min(1).max(100).optional(),
	description: z.string().trim().min(1).max(500).optional(),
	content: z.string().trim().min(1).optional(),
	tags: z.array(z.string().trim().min(1)).optional(),
	enabled: z.boolean().optional(),
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

export const createSkillCommand = command(createSkillSchema, async ({ name, description, content, tags }) => {
	return createSkill(name, description, content, tags)
})

export const updateSkillCommand = command(updateSkillSchema, async ({ id, ...fields }) => {
	return updateSkill(id, fields)
})

export const deleteSkillCommand = command(skillIdSchema, async ({ id }) => {
	await deleteSkill(id)
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

