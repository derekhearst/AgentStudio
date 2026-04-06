import { z } from 'zod'
import { webSearch } from '$lib/tools/search'
import {
	browserNavigate,
	browserScreenshot,
	execShell,
	readFile,
	writeFile,
	patchFile,
	replaceInFile,
	listDirectory,
	deleteFile,
	moveFile,
	searchFiles,
	fileInfo,
} from '$lib/tools/sandbox'
import { searchMemories } from '$lib/memory/store'
import { runSubagent } from '$lib/agents/subagent'
import { generateImage } from '$lib/tools/imagegen'
import { db } from '$lib/db.server'
import { artifacts, artifactVersions } from '$lib/artifacts/artifacts.schema'
import { eq, max } from 'drizzle-orm'
import {
	listSkillSummaries,
	getSkillByName,
	getSkillFileByName,
	createSkill,
	updateSkill as updateSkillRecord,
	deleteSkill as deleteSkillRecord,
	addSkillFile,
	updateSkillFile as updateSkillFileRecord,
	deleteSkillFile as deleteSkillFileRecord,
	bumpSkillAccess,
} from '$lib/skills/store'

export const toolSchemas = {
	web_search: z.object({ query: z.string().min(1) }),
	shell: z.object({ command: z.string().min(1) }),
	file_read: z.object({
		path: z.string().min(1),
		startLine: z.number().int().min(1).optional(),
		endLine: z.number().int().min(1).optional(),
	}),
	file_write: z.object({ path: z.string().min(1), content: z.string() }),
	file_patch: z.object({ patch: z.string().min(1) }),
	file_replace: z.object({
		path: z.string().min(1),
		oldStr: z.string().min(1),
		newStr: z.string(),
		requireUnique: z.boolean().default(true),
		replaceAll: z.boolean().default(false),
	}),
	list_directory: z.object({
		path: z.string().min(1).optional(),
		depth: z.number().int().min(0).max(6).default(1),
		includeHidden: z.boolean().default(false),
	}),
	delete_file: z.object({ path: z.string().min(1), recursive: z.boolean().default(false) }),
	move_file: z.object({
		fromPath: z.string().min(1),
		toPath: z.string().min(1),
		overwrite: z.boolean().default(false),
	}),
	search_files: z.object({
		query: z.string().min(1),
		path: z.string().min(1).optional(),
		maxResults: z.number().int().min(1).max(200).default(50),
		isRegex: z.boolean().default(false),
		includeIgnored: z.boolean().default(false),
		caseSensitive: z.boolean().default(false),
	}),
	file_info: z.object({ path: z.string().min(1) }),
	browser_screenshot: z.object({ url: z.string().url().optional() }),
	memory_search: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) }),
	create_task: z.object({ title: z.string().min(1), description: z.string().min(1) }),
	run_subagent: z.object({ task: z.string().min(1), context: z.string().optional() }),
	image_generate: z.object({
		prompt: z.string().min(1).max(2000),
		model: z.enum(['flux', 'sdxl', 'dall-e']).default('flux'),
		size: z.enum(['256x256', '512x512', '1024x1024']).default('1024x1024'),
	}),
	artifact_create: z.object({
		type: z.enum([
			'markdown',
			'code',
			'config',
			'image',
			'svg',
			'mermaid',
			'html',
			'svelte',
			'data_table',
			'chart',
			'audio',
			'video',
		]),
		title: z.string().min(1).max(200),
		content: z.string(),
		language: z.string().max(60).optional(),
		category: z.string().max(60).optional(),
	}),
	artifact_update: z.object({
		artifactId: z.string().uuid(),
		content: z.string(),
		title: z.string().min(1).max(200).optional(),
	}),
	artifact_storage_update: z.object({
		artifactId: z.string().uuid(),
		key: z.string().min(1).max(200),
		value: z.unknown(),
	}),
	list_skills: z.object({}),
	read_skill: z.object({ name: z.string().min(1) }),
	read_skill_file: z.object({ skillName: z.string().min(1), fileName: z.string().min(1) }),
	create_skill: z.object({
		name: z.string().min(1).max(100),
		description: z.string().min(1).max(500),
		content: z.string().min(1),
		tags: z.array(z.string()).optional(),
	}),
	update_skill: z.object({
		name: z.string().min(1),
		description: z.string().min(1).max(500).optional(),
		content: z.string().min(1).optional(),
		tags: z.array(z.string()).optional(),
	}),
	add_skill_file: z.object({
		skillName: z.string().min(1),
		fileName: z.string().min(1).max(200),
		description: z.string().max(500).default(''),
		content: z.string().min(1),
	}),
	update_skill_file: z.object({
		skillName: z.string().min(1),
		fileName: z.string().min(1),
		content: z.string().min(1).optional(),
		description: z.string().max(500).optional(),
	}),
	delete_skill: z.object({ name: z.string().min(1) }),
	delete_skill_file: z.object({ skillName: z.string().min(1), fileName: z.string().min(1) }),
}

export type ToolName = keyof typeof toolSchemas

export const allToolNames = Object.keys(toolSchemas) as ToolName[]

const toolDescriptions: Record<ToolName, string> = {
	web_search: 'Search the web for information.',
	shell: 'Run a shell command in the sandboxed environment.',
	file_read: 'Read a file from the sandbox filesystem, optionally by line range.',
	file_write: 'Write content to a file in the sandbox filesystem.',
	file_patch: 'Apply a unified diff patch to files in the sandbox workspace.',
	file_replace:
		'Replace an exact string in a file. By default requires exactly one match, making edits deterministic and retry-safe.',
	list_directory: 'List files and directories with depth and hidden-file controls.',
	delete_file: 'Delete a file or directory (recursive deletes require explicit recursive=true).',
	move_file: 'Move or rename a file/directory within the sandbox workspace.',
	search_files: 'Search file contents in the workspace (ripgrep-style) with optional regex and ignore controls.',
	file_info: 'Get file or directory metadata (size, modified time, permissions).',
	browser_screenshot: 'Take a screenshot of a web page.',
	memory_search: 'Search persistent memory for relevant information.',
	create_task: 'Create a new agent task.',
	run_subagent:
		'Run a general-purpose subagent to handle a task. The subagent is stateless and returns a result without persistence.',
	image_generate: 'Generate an image from a text prompt.',
	artifact_create:
		'Create a persistent artifact (document, code, config, diagram, etc.). Use for code snippets over 15 lines, full documents, configs, diagrams, data tables, HTML pages, and Svelte components.',
	artifact_update: 'Update the content of an existing artifact. Creates a new version automatically.',
	artifact_storage_update:
		"Update a key in an artifact's persistent storage. Used for reactive/living artifacts like trackers and dashboards.",
	list_skills:
		'List all available skills with their names, descriptions, and nested file names. Use this to discover what skills are available.',
	read_skill:
		'Read a skill by name. Returns the main content and a list of available nested files. Use this when a skill is relevant to the current task.',
	read_skill_file: 'Read a specific nested file within a skill. Use after read_skill to load additional context files.',
	create_skill:
		'Create a new skill with a name, description, and main content. Skills are reusable instruction/knowledge bundles. Keep main content under 8KB.',
	update_skill: 'Update an existing skill by name. Can modify description, content, or tags.',
	add_skill_file:
		'Add a nested file to an existing skill. Files provide optional additional context (e.g., examples, sub-topics).',
	update_skill_file: 'Update a nested file within a skill by skill name and file name.',
	delete_skill: 'Delete a skill and all its nested files by name.',
	delete_skill_file: 'Delete a specific nested file from a skill.',
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
	return z.toJSONSchema(schema) as Record<string, unknown>
}

/**
 * Returns tool definitions for the LLM.
 * When `onlyTools` is provided, only those tools are included (capability filtering).
 * When omitted, all tools are returned (backwards compatible).
 */
export function getToolDefinitions(onlyTools?: ToolName[]) {
	const entries = onlyTools
		? Object.entries(toolSchemas).filter(([name]) => onlyTools.includes(name as ToolName))
		: Object.entries(toolSchemas)

	return entries.map(([name, schema]) => ({
		type: 'function' as const,
		function: {
			name,
			description: toolDescriptions[name as ToolName],
			parameters: zodToJsonSchema(schema),
		},
	}))
}

export type ToolCall = {
	name: ToolName
	arguments: unknown
}

export type ToolCallWithContext = ToolCall & {
	conversationId?: string | null
	messageId?: string | null
}

export async function executeTool(call: ToolCall) {
	const startedAt = Date.now()
	try {
		if (call.name === 'web_search') {
			const input = toolSchemas.web_search.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await webSearch(input.query),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'shell') {
			const input = toolSchemas.shell.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await execShell(input.command),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'file_read') {
			const input = toolSchemas.file_read.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await readFile(input.path, input.startLine, input.endLine),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'file_write') {
			const input = toolSchemas.file_write.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await writeFile(input.path, input.content),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'file_patch') {
			const input = toolSchemas.file_patch.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await patchFile(input.patch),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'file_replace') {
			const input = toolSchemas.file_replace.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await replaceInFile(input.path, input.oldStr, input.newStr, {
					requireUnique: input.requireUnique,
					replaceAll: input.replaceAll,
				}),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'list_directory') {
			const input = toolSchemas.list_directory.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await listDirectory(input.path, input.depth, input.includeHidden),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'delete_file') {
			const input = toolSchemas.delete_file.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await deleteFile(input.path, input.recursive),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'move_file') {
			const input = toolSchemas.move_file.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await moveFile(input.fromPath, input.toPath, input.overwrite),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'search_files') {
			const input = toolSchemas.search_files.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await searchFiles(input.query, {
					path: input.path,
					maxResults: input.maxResults,
					isRegex: input.isRegex,
					includeIgnored: input.includeIgnored,
					caseSensitive: input.caseSensitive,
				}),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'file_info') {
			const input = toolSchemas.file_info.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await fileInfo(input.path),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'browser_screenshot') {
			const input = toolSchemas.browser_screenshot.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await browserScreenshot(input.url),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'memory_search') {
			const input = toolSchemas.memory_search.parse(call.arguments)
			const matches = await searchMemories(input.query, input.limit)
			return {
				success: true,
				tool: call.name,
				input,
				result: matches,
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'create_task') {
			const input = toolSchemas.create_task.parse(call.arguments)
			const { createTaskForAvailableAgent } = await import('$lib/agents/engine')
			const task = await createTaskForAvailableAgent(input.title, input.description)
			return {
				success: true,
				tool: call.name,
				input,
				result: task,
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'image_generate') {
			const input = toolSchemas.image_generate.parse(call.arguments)
			const result = await generateImage(input.prompt, input.model, input.size)
			return {
				success: true,
				tool: call.name,
				input,
				result,
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'artifact_create') {
			const input = toolSchemas.artifact_create.parse(call.arguments)
			const [artifact] = await db
				.insert(artifacts)
				.values({
					type: input.type,
					title: input.title,
					content: input.content,
					language: input.language ?? null,
					category: input.category ?? null,
					conversationId: (call as ToolCallWithContext).conversationId ?? null,
					messageId: (call as ToolCallWithContext).messageId ?? null,
				})
				.returning()

			await db.insert(artifactVersions).values({
				artifactId: artifact.id,
				version: 1,
				content: input.content,
				language: input.language ?? null,
				metadata: {},
			})

			return {
				success: true,
				tool: call.name,
				input,
				result: { artifactId: artifact.id, title: artifact.title, type: artifact.type },
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'artifact_update') {
			const input = toolSchemas.artifact_update.parse(call.arguments)

			const [existing] = await db.select().from(artifacts).where(eq(artifacts.id, input.artifactId)).limit(1)
			if (!existing) {
				return { success: false, tool: call.name, error: 'Artifact not found', executionMs: Date.now() - startedAt }
			}

			const updates: Record<string, unknown> = { content: input.content, updatedAt: new Date() }
			if (input.title) updates.title = input.title

			await db.update(artifacts).set(updates).where(eq(artifacts.id, input.artifactId))

			// Auto-version
			const [maxRow] = await db
				.select({ maxVersion: max(artifactVersions.version) })
				.from(artifactVersions)
				.where(eq(artifactVersions.artifactId, input.artifactId))

			const nextVersion = (maxRow?.maxVersion ?? 0) + 1
			await db.insert(artifactVersions).values({
				artifactId: input.artifactId,
				version: nextVersion,
				content: input.content,
				language: existing.language,
				metadata: {},
			})

			return {
				success: true,
				tool: call.name,
				input,
				result: { artifactId: input.artifactId, version: nextVersion },
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'artifact_storage_update') {
			const input = toolSchemas.artifact_storage_update.parse(call.arguments)

			const [existing] = await db
				.select({ storage: artifacts.storage })
				.from(artifacts)
				.where(eq(artifacts.id, input.artifactId))
				.limit(1)

			if (!existing) {
				return { success: false, tool: call.name, error: 'Artifact not found', executionMs: Date.now() - startedAt }
			}

			const newStorage = { ...existing.storage, [input.key]: input.value }
			await db
				.update(artifacts)
				.set({ storage: newStorage, updatedAt: new Date() })
				.where(eq(artifacts.id, input.artifactId))

			return {
				success: true,
				tool: call.name,
				input,
				result: { artifactId: input.artifactId, updatedKey: input.key },
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'list_skills') {
			const summaries = await listSkillSummaries()
			return {
				success: true,
				tool: call.name,
				input: {},
				result: summaries,
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'read_skill') {
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
		}

		if (call.name === 'read_skill_file') {
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
		}

		if (call.name === 'create_skill') {
			const input = toolSchemas.create_skill.parse(call.arguments)
			const skill = await createSkill(input.name, input.description, input.content, input.tags)
			return {
				success: true,
				tool: call.name,
				input,
				result: { id: skill.id, name: skill.name },
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'update_skill') {
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
		}

		if (call.name === 'add_skill_file') {
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
		}

		if (call.name === 'update_skill_file') {
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
		}

		if (call.name === 'delete_skill') {
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
		}

		if (call.name === 'delete_skill_file') {
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
		}

		const input = toolSchemas.run_subagent.parse(call.arguments)
		const result = await runSubagent(input.task, input.context)
		return {
			success: true,
			tool: call.name,
			input,
			result,
			executionMs: Date.now() - startedAt,
		}
	} catch (error) {
		return {
			success: false,
			tool: call.name,
			error: error instanceof Error ? error.message : 'Tool execution failed',
			executionMs: Date.now() - startedAt,
		}
	}
}
