/**
 * Skill + skill-file CRUD handlers.
 *
 * `read_skill` / `read_skill_file` bump access counters (used by the recall ranker)
 * before returning content. Mutations route through the skills domain helpers so
 * embedding regeneration / cache invalidation happens consistently.
 */

import { toolSchemas } from '../tool-schemas'
import {
	addSkillFile,
	bumpSkillAccess,
	createSkill,
	deleteSkill as deleteSkillRecord,
	deleteSkillFile as deleteSkillFileRecord,
	getSkillByName,
	getSkillFileByName,
	listSkillSummaries,
	updateSkill as updateSkillRecord,
	updateSkillFile as updateSkillFileRecord,
} from '$lib/skills/skills.server'
import type { ToolHandler } from '../handler-types'

export const skillsHandlers: Record<string, ToolHandler> = {
	list_skills: async (call, { startedAt }) => {
		const summaries = await listSkillSummaries()
		return {
			success: true,
			tool: call.name,
			input: {},
			result: summaries,
			executionMs: Date.now() - startedAt,
		}
	},

	read_skill: async (call, { startedAt }) => {
		const input = toolSchemas.read_skill.parse(call.arguments)
		const skill = await getSkillByName(input.name)
		if (!skill) {
			return {
				success: false,
				tool: call.name,
				error: `Skill "${input.name}" not found`,
				executionMs: Date.now() - startedAt,
			}
		}
		await bumpSkillAccess(skill.id)
		return {
			success: true,
			tool: call.name,
			input,
			result: {
				name: skill.name,
				description: skill.description,
				content: skill.content,
				tags: skill.tags,
				files: skill.files.map((f) => ({ name: f.name, description: f.description })),
			},
			executionMs: Date.now() - startedAt,
		}
	},

	read_skill_file: async (call, { startedAt }) => {
		const input = toolSchemas.read_skill_file.parse(call.arguments)
		const skill = await getSkillByName(input.skillName)
		if (!skill) {
			return {
				success: false,
				tool: call.name,
				error: `Skill "${input.skillName}" not found`,
				executionMs: Date.now() - startedAt,
			}
		}
		const file = await getSkillFileByName(skill.id, input.fileName)
		if (!file) {
			return {
				success: false,
				tool: call.name,
				error: `File "${input.fileName}" not found in skill "${input.skillName}"`,
				executionMs: Date.now() - startedAt,
			}
		}
		await bumpSkillAccess(skill.id)
		return {
			success: true,
			tool: call.name,
			input,
			result: { name: file.name, description: file.description, content: file.content },
			executionMs: Date.now() - startedAt,
		}
	},

	create_skill: async (call, { startedAt }) => {
		const input = toolSchemas.create_skill.parse(call.arguments)
		const skill = await createSkill(input.name, input.description, input.content, input.tags)
		return {
			success: true,
			tool: call.name,
			input,
			result: { id: skill.id, name: skill.name },
			executionMs: Date.now() - startedAt,
		}
	},

	update_skill: async (call, { startedAt }) => {
		const input = toolSchemas.update_skill.parse(call.arguments)
		const skill = await getSkillByName(input.name)
		if (!skill) {
			return {
				success: false,
				tool: call.name,
				error: `Skill "${input.name}" not found`,
				executionMs: Date.now() - startedAt,
			}
		}
		const { name: _name, ...fields } = input
		const updated = await updateSkillRecord(skill.id, fields)
		return {
			success: true,
			tool: call.name,
			input,
			result: { id: updated.id, name: updated.name },
			executionMs: Date.now() - startedAt,
		}
	},

	add_skill_file: async (call, { startedAt }) => {
		const input = toolSchemas.add_skill_file.parse(call.arguments)
		const skill = await getSkillByName(input.skillName)
		if (!skill) {
			return {
				success: false,
				tool: call.name,
				error: `Skill "${input.skillName}" not found`,
				executionMs: Date.now() - startedAt,
			}
		}
		const file = await addSkillFile(skill.id, input.fileName, input.description, input.content)
		return {
			success: true,
			tool: call.name,
			input,
			result: { fileId: file.id, name: file.name },
			executionMs: Date.now() - startedAt,
		}
	},

	update_skill_file: async (call, { startedAt }) => {
		const input = toolSchemas.update_skill_file.parse(call.arguments)
		const skill = await getSkillByName(input.skillName)
		if (!skill) {
			return {
				success: false,
				tool: call.name,
				error: `Skill "${input.skillName}" not found`,
				executionMs: Date.now() - startedAt,
			}
		}
		const file = await getSkillFileByName(skill.id, input.fileName)
		if (!file) {
			return {
				success: false,
				tool: call.name,
				error: `File "${input.fileName}" not found in skill "${input.skillName}"`,
				executionMs: Date.now() - startedAt,
			}
		}
		const { skillName: _s, fileName: _f, ...fields } = input
		const updated = await updateSkillFileRecord(file.id, fields)
		return {
			success: true,
			tool: call.name,
			input,
			result: { fileId: updated.id, name: updated.name },
			executionMs: Date.now() - startedAt,
		}
	},

	delete_skill: async (call, { startedAt }) => {
		const input = toolSchemas.delete_skill.parse(call.arguments)
		const skill = await getSkillByName(input.name)
		if (!skill) {
			return {
				success: false,
				tool: call.name,
				error: `Skill "${input.name}" not found`,
				executionMs: Date.now() - startedAt,
			}
		}
		await deleteSkillRecord(skill.id)
		return {
			success: true,
			tool: call.name,
			input,
			result: { deleted: input.name },
			executionMs: Date.now() - startedAt,
		}
	},

	delete_skill_file: async (call, { startedAt }) => {
		const input = toolSchemas.delete_skill_file.parse(call.arguments)
		const skill = await getSkillByName(input.skillName)
		if (!skill) {
			return {
				success: false,
				tool: call.name,
				error: `Skill "${input.skillName}" not found`,
				executionMs: Date.now() - startedAt,
			}
		}
		const file = await getSkillFileByName(skill.id, input.fileName)
		if (!file) {
			return {
				success: false,
				tool: call.name,
				error: `File "${input.fileName}" not found in skill "${input.skillName}"`,
				executionMs: Date.now() - startedAt,
			}
		}
		await deleteSkillFileRecord(file.id)
		return {
			success: true,
			tool: call.name,
			input,
			result: { deleted: input.fileName, fromSkill: input.skillName },
			executionMs: Date.now() - startedAt,
		}
	},
}
