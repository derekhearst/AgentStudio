import { z } from 'zod'
import {
	toolSchemas,
	toolDescriptions,
	toolExamples,
	toolDisclosure,
	searchToolsRegistry,
	allToolNames,
	normalizeToolName,
	type ToolName,
} from './tool-schemas'
import {
	toolUserContext,
	getWorkspace,
	safePath,
	ensureWorkspaceDir,
	shellExec,
	fileRead,
	fileReadRange,
	fileWrite,
	fileDelete,
	fileMove,
	fileList,
	sandboxFileInfo,
	fileSearch,
	fileStrReplace,
	filePatch,
	getPage,
	sandboxBrowserNavigate,
	sandboxBrowserScreenshot,
	browserClose,
	type WorktreeStoreConfig,
	type ToolRuntimeContext,
} from './sandbox.server'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'

const execFileAsync = promisify(execFile)
import { db } from '$lib/db.server'
import { getSandboxRoot, getSearchCostPerCall, getSearxngUrl } from '$lib/server/config'
import { eq } from 'drizzle-orm'
import { setAgentStatus, updateAgentRecord } from '$lib/agents/agents.server'
import { safePathWithin } from '$lib/workspace/workspace.server'
import { logToolUsage } from '$lib/costs/usage'
import { webSearch } from './web-search.server'
import { generateImage } from './image-gen.server'
import { webFetch, pdfRead } from './web-fetch.server'
import { assertArtifactAccessible, resolveConversationFromRunId } from './artifact-scope.server'
import {
	createAutomationRecord,
	deleteAutomationRecord,
	listAutomationsForUser,
	updateAutomationRecord,
} from '$lib/automations/automation.server'
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
} from '$lib/skills/skills.server'
import { logger } from '$lib/observability/logger'

// Re-export tool implementations that have been extracted into focused modules.
// External callers ($lib/tools/tools.remote.ts, $lib/research/research-runner.server.ts) keep
// importing from this barrel.
export { webSearch } from './web-search.server'
export { generateImage } from './image-gen.server'
export { webFetch, pdfRead } from './web-fetch.server'

export async function execShell(command: string) {
	const result = await shellExec(command)
	return {
		success: result.exitCode === 0,
		command,
		status: result.exitCode === 0 ? 'completed' : 'failed',
		exitCode: result.exitCode,
		output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
		raw: result,
	}
}

export async function readFile(path: string, startLine?: number, endLine?: number) {
	const content =
		startLine !== undefined || endLine !== undefined
			? await fileReadRange(path, { startLine, endLine })
			: await fileRead(path)
	return { path, content }
}

export async function writeFile(path: string, content: string) {
	await fileWrite(path, content)
	return {
		success: true,
		path,
		message: `File written (${content.length} chars)`,
	}
}

export async function patchFile(patch: string) {
	return filePatch(patch)
}

export async function replaceInFile(
	path: string,
	oldStr: string,
	newStr: string,
	options?: { requireUnique?: boolean; replaceAll?: boolean },
) {
	return fileStrReplace(path, oldStr, newStr, options)
}

export async function listDirectory(path?: string, depth = 1, includeHidden = false) {
	return fileList(path, { depth, includeHidden })
}

export async function deleteFile(path: string, recursive = false) {
	await fileDelete(path, recursive)
	return { success: true, path, recursive }
}

export async function moveFile(fromPath: string, toPath: string, overwrite = false) {
	const result = await fileMove(fromPath, toPath, overwrite)
	return { success: true, ...result }
}

export async function searchFiles(
	query: string,
	options?: {
		path?: string
		maxResults?: number
		isRegex?: boolean
		includeIgnored?: boolean
		caseSensitive?: boolean
	},
) {
	return fileSearch(query, options)
}

export async function fileInfo(path: string) {
	return sandboxFileInfo(path)
}

export async function browserNavigate(url: string) {
	const result = await sandboxBrowserNavigate(url)
	return {
		success: true,
		url: result.url,
		title: result.title,
	}
}

export async function browserScreenshot(url?: string) {
	if (url) {
		await sandboxBrowserNavigate(url)
	}
	const buffer = await sandboxBrowserScreenshot()
	return {
		mimeType: 'image/png',
		imageBase64: buffer.toString('base64'),
	}
}

export async function getSandboxStatus() {
	const workspace = getSandboxRoot()
	try {
		const s = await stat(workspace)
		return {
			success: s.isDirectory(),
			message: s.isDirectory() ? 'Sandbox workspace accessible' : 'Sandbox workspace path is not a directory',
			stats: { workspace, isDirectory: s.isDirectory() },
		}
	} catch {
		return {
			success: false,
			message: `Sandbox workspace not found: ${workspace}`,
			stats: null,
		}
	}
}

export { browserClose }
export { toolSchemas, allToolNames, type ToolName } from './tool-schemas'

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
	return z.toJSONSchema(schema) as Record<string, unknown>
}

/**
 * Returns tool definitions for the LLM.
 * When `onlyTools` is provided, only those tools are included (capability filtering).
 * When omitted, all tools are returned (backwards compatible).
 */
/**
 * Build OpenAI-style tool definitions. When `onlyTools` is passed, the result is filtered to
 * exactly that set (used for agents with a fixed `allowedTools` policy). Otherwise we apply the
 * Tool Search Tool tier filter:
 *
 *   - `disclosure: 'always'` tools are always included.
 *   - `disclosure: 'searchable'` tools are included only if their name is in `loadedSearchable`,
 *     which the runtime maintains per-run (search_tools side-effect → next-round refresh).
 *
 * Pass `tierFilter: false` to ignore tiers entirely (returns the whole registry — currently used
 * by the MCP endpoint, which exposes the full surface to external clients).
 */
export function getToolDefinitions(
	onlyTools?: ToolName[],
	options?: { tierFilter?: boolean; loadedSearchable?: ReadonlySet<string> },
) {
	const tierFilter = options?.tierFilter !== false
	const loadedSearchable = options?.loadedSearchable

	const entries = onlyTools
		? Object.entries(toolSchemas).filter(([name]) => onlyTools.includes(name as ToolName))
		: Object.entries(toolSchemas).filter(([name]) => {
				if (!tierFilter) return true
				const tier = toolDisclosure[name as ToolName]
				if (tier === 'always') return true
				if (tier === 'searchable') return loadedSearchable?.has(name) ?? false
				return false
			})

	return entries.map(([name, schema]) => {
		const examples = toolExamples[name as ToolName]
		return {
			type: 'function' as const,
			function: {
				name,
				description: toolDescriptions[name as ToolName],
				parameters: zodToJsonSchema(schema),
				// Anthropic-style `input_examples`. Other providers ignore unknown fields.
				// OpenRouter forwards extras on tool defs through to the upstream provider.
				...(examples && examples.length > 0 ? { input_examples: examples } : {}),
			},
		}
	})
}

export type ToolCall = {
	name: ToolName
	arguments: unknown
}

export type ToolCallWithContext = ToolCall & {
	conversationId?: string | null
	messageId?: string | null
}

// re-export for callers that previously imported from tools.server
export { normalizeToolName }

export type WorkspaceOptions = {
	persistentKey?: string | null
	worktree?: WorktreeStoreConfig | null
	/**
	 * Project ID for project-bound chat runs. The chat-loop entry point reads this from
	 * `conversations.projectId` and passes it through. Surfaces in the AsyncLocalStorage
	 * so workspace resolution lands the cwd at `<sandbox>/<userId>/projects/<projectId>`.
	 */
	projectId?: string | null
	/**
	 * Optional runtime hooks for tools that need to dispatch nested calls (currently `run_code`).
	 * The loop populates this; standalone callers (MCP HTTP endpoint, automations) pass nothing
	 * and run_code falls back to a no-session, empty-approval-set, all-tools-enabled mode.
	 */
	runtime?: ToolRuntimeContext | null
}

export async function executeTool(
	call: ToolCall,
	userId: string,
	runId?: string | null,
	workspace?: WorkspaceOptions,
) {
	return toolUserContext.run(
		{
			userId,
			runId: runId ?? null,
			persistentKey: workspace?.persistentKey ?? null,
			worktree: workspace?.worktree ?? null,
			projectId: workspace?.projectId ?? null,
			runtime: workspace?.runtime ?? null,
		},
		async () => {
		const startedAt = Date.now()
		const normalizedName = normalizeToolName(call.name)
		if (!normalizedName) {
			return {
				success: false,
				tool: call.name,
				error: `Unknown tool: ${call.name}`,
				executionMs: Date.now() - startedAt,
			}
		}
		if (normalizedName !== call.name) {
			call = { ...call, name: normalizedName }
		}

		try {
			if (call.name === 'web_search') {
				const input = toolSchemas.web_search.parse(call.arguments)
				const ctx = toolUserContext.getStore()
				const result = await webSearch(input.query)
				// Phase 2 ledger: log every web_search as 1 call. SEARCH_COST_PER_CALL_USD lets
				// operators set a per-call cost (e.g. for paid backends like Serper); SearXNG is
				// self-hosted so cost defaults to 0 but the call count is still tracked.
				const costPerCall = getSearchCostPerCall()
				void logToolUsage({
					toolName: 'web_search',
					provider: getSearxngUrl() ? 'searxng' : null,
					unitType: 'call',
					units: 1,
					cost: costPerCall,
					userId: ctx?.userId ?? null,
					runId: ctx?.runId ?? null,
					metadata: { query: input.query.slice(0, 240), resultCount: result.length },
				}).catch((err) => logger.warn('[tool-usage] web_search log failed', { err }))
				return {
					success: true,
					tool: call.name,
					input,
					result,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'shell') {
				const input = toolSchemas.shell.parse(call.arguments)
				const shellResult = await execShell(input.command)
				return {
					success: shellResult.success,
					tool: call.name,
					input,
					result: shellResult,
					error: shellResult.success ? undefined : shellResult.output,
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

			if (call.name === 'web_fetch') {
				const input = toolSchemas.web_fetch.parse(call.arguments)
				const result = await webFetch(input.url, input.maxChars)
				return {
					success: true,
					tool: call.name,
					input,
					result,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'pdf_read') {
				const input = toolSchemas.pdf_read.parse(call.arguments)
				const result = await pdfRead(input.source, input.maxChars)
				return {
					success: true,
					tool: call.name,
					input,
					result,
					executionMs: Date.now() - startedAt,
				}
			}

			// Wave 4 #15 phase 2 finish — bind a project to the current conversation so
			// subsequent edits target it by default. Updates conversations.project_id.
			if (call.name === 'set_project_context') {
				const input = toolSchemas.set_project_context.parse(call.arguments)
				const ctxSnapshot = toolUserContext.getStore()
				const conversationId = await resolveConversationFromRunId(ctxSnapshot?.runId ?? null)
				if (!conversationId) {
					return {
						success: false,
						tool: call.name,
						error: 'no conversation context available for this tool call',
						executionMs: Date.now() - startedAt,
					}
				}
				if (input.projectId) {
					// Verify ownership before binding.
					const projectsModule = await import('$lib/projects/projects.server')
					const project = await projectsModule.getProjectById(input.projectId)
					if (!project || project.userId !== userId) {
						return {
							success: false,
							tool: call.name,
							error: `Project ${input.projectId} not found or not accessible`,
							executionMs: Date.now() - startedAt,
						}
					}
				}
				const { conversations: convoTable } = await import('$lib/sessions/sessions.schema')
				const { eq } = await import('drizzle-orm')
				await db
					.update(convoTable)
					.set({ projectId: input.projectId ?? null, updatedAt: new Date() })
					.where(eq(convoTable.id, conversationId))
				return {
					success: true,
					tool: call.name,
					input,
					result: {
						conversationId,
						projectId: input.projectId ?? null,
						bound: input.projectId !== null && input.projectId !== undefined,
					},
					executionMs: Date.now() - startedAt,
				}
			}

			// Wave 4 #15 phase 2 — Projects + Artifacts agent tools.
			if (
				call.name === 'list_projects' ||
				call.name === 'create_project' ||
				call.name === 'list_artifacts' ||
				call.name === 'read_artifact' ||
				call.name === 'create_artifact' ||
				call.name === 'edit_artifact' ||
				call.name === 'present_artifact'
			) {
				const projectsModule = await import('$lib/projects/projects.server')
				if (call.name === 'list_projects') {
					toolSchemas.list_projects.parse(call.arguments)
					const rows = await projectsModule.listProjects(userId)
					return {
						success: true,
						tool: call.name,
						input: {},
						result: rows.map((r) => ({
							id: r.id,
							name: r.name,
							slug: r.slug,
							kind: r.kind,
							description: r.description,
							updatedAt: r.updatedAt,
						})),
						executionMs: Date.now() - startedAt,
					}
				}
				if (call.name === 'create_project') {
					const input = toolSchemas.create_project.parse(call.arguments)
					const { project: created } = await projectsModule.createProject({
						userId,
						name: input.name,
						kind: input.kind,
						description: input.description ?? null,
						repoMode: 'none',
					})
					return {
						success: true,
						tool: call.name,
						input,
						result: { id: created.id, name: created.name, slug: created.slug, kind: created.kind },
						executionMs: Date.now() - startedAt,
					}
				}
				if (call.name === 'list_artifacts') {
					const input = toolSchemas.list_artifacts.parse(call.arguments)

					if (input.projectId) {
						const project = await projectsModule.getProjectById(input.projectId)
						if (!project || project.userId !== userId) {
							return {
								success: false,
								tool: call.name,
								error: `Project ${input.projectId} not found or not accessible`,
								executionMs: Date.now() - startedAt,
							}
						}
						const rows = await projectsModule.listArtifactsForProject(input.projectId, {
							includeInactive: input.includeInactive,
						})
						return {
							success: true,
							tool: call.name,
							input,
							result: rows.map((a) => ({
								id: a.id,
								name: a.name,
								slug: a.slug,
								contentType: a.contentType,
								isActive: a.isActive,
								updatedAt: a.updatedAt,
							})),
							executionMs: Date.now() - startedAt,
						}
					}

					// Conversation-scoped: explicit conversationId, or fall back to the current chat run.
					const conversationId =
						input.conversationId ?? (await resolveConversationFromRunId(toolUserContext.getStore()?.runId ?? null))
					if (!conversationId) {
						return {
							success: false,
							tool: call.name,
							error: 'No projectId provided and no conversation context — pass projectId or conversationId.',
							executionMs: Date.now() - startedAt,
						}
					}
					const rows = await projectsModule.listArtifactsForConversation(conversationId, {
						includeInactive: input.includeInactive,
					})
					return {
						success: true,
						tool: call.name,
						input,
						result: rows.map((a) => ({
							id: a.id,
							name: a.name,
							slug: a.slug,
							contentType: a.contentType,
							isActive: a.isActive,
							updatedAt: a.updatedAt,
						})),
						executionMs: Date.now() - startedAt,
					}
				}
				if (call.name === 'read_artifact') {
					const input = toolSchemas.read_artifact.parse(call.arguments)
					const artifact = await projectsModule.getArtifactById(input.artifactId)
					if (!artifact) {
						return {
							success: false,
							tool: call.name,
							error: `Artifact ${input.artifactId} not found`,
							executionMs: Date.now() - startedAt,
						}
					}
					const ownership = await assertArtifactAccessible(artifact, userId)
					if (!ownership.ok) {
						return {
							success: false,
							tool: call.name,
							error: ownership.error,
							executionMs: Date.now() - startedAt,
						}
					}
					return {
						success: true,
						tool: call.name,
						input,
						result: {
							id: artifact.id,
							name: artifact.name,
							slug: artifact.slug,
							contentType: artifact.contentType,
							projectId: artifact.projectId,
							conversationId: artifact.conversationId,
							projectName: ownership.projectName,
							versionSeq: artifact.currentVersion ? 1 : 0,
							currentVersionId: artifact.currentVersionId,
							content: artifact.currentVersion?.content ?? '',
						},
						executionMs: Date.now() - startedAt,
					}
				}
				if (call.name === 'create_artifact') {
					const input = toolSchemas.create_artifact.parse(call.arguments)

					let scopedProjectId: string | null = null
					let scopedConversationId: string | null = null

					if (input.projectId) {
						const project = await projectsModule.getProjectById(input.projectId)
						if (!project || project.userId !== userId) {
							return {
								success: false,
								tool: call.name,
								error: `Project ${input.projectId} not found or not accessible`,
								executionMs: Date.now() - startedAt,
							}
						}
						scopedProjectId = project.id
					} else {
						scopedConversationId =
							input.conversationId ??
							(await resolveConversationFromRunId(toolUserContext.getStore()?.runId ?? null))
						if (!scopedConversationId) {
							return {
								success: false,
								tool: call.name,
								error: 'No projectId provided and no conversation context — pass projectId or conversationId.',
								executionMs: Date.now() - startedAt,
							}
						}
					}

					const created = await projectsModule.createArtifact({
						projectId: scopedProjectId,
						conversationId: scopedConversationId,
						name: input.name,
						content: input.content,
						contentType: input.contentType,
						changeNote: input.changeNote,
						editedBy: userId,
						sourceRunId: toolUserContext.getStore()?.runId ?? null,
					})
					return {
						success: true,
						tool: call.name,
						input: { ...input, content: `[${input.content.length} chars]` },
						result: {
							id: created.id,
							name: created.name,
							slug: created.slug,
							contentType: created.contentType,
							projectId: created.projectId,
							conversationId: created.conversationId,
							versionSeq: 1,
						},
						executionMs: Date.now() - startedAt,
					}
				}
				if (call.name === 'present_artifact') {
					const input = toolSchemas.present_artifact.parse(call.arguments)
					const artifact = await projectsModule.getArtifactById(input.artifactId)
					if (!artifact) {
						return {
							success: false,
							tool: call.name,
							error: `Artifact ${input.artifactId} not found`,
							executionMs: Date.now() - startedAt,
						}
					}
					const ownership = await assertArtifactAccessible(artifact, userId)
					if (!ownership.ok) {
						return {
							success: false,
							tool: call.name,
							error: ownership.error,
							executionMs: Date.now() - startedAt,
						}
					}
					let version = artifact.currentVersion
					if (input.versionSeq && (!version || version.seq !== input.versionSeq)) {
						const history = await projectsModule.getVersionHistory(artifact.id)
						version = history.find((v) => v.seq === input.versionSeq) ?? null
					}
					if (!version) {
						return {
							success: false,
							tool: call.name,
							error: `Artifact ${input.artifactId} has no version content`,
							executionMs: Date.now() - startedAt,
						}
					}
					return {
						success: true,
						tool: call.name,
						input,
						result: {
							artifactId: artifact.id,
							name: artifact.name,
							slug: artifact.slug,
							contentType: artifact.contentType,
							projectId: artifact.projectId,
							conversationId: artifact.conversationId,
							versionSeq: version.seq,
							content: version.content,
							focus: input.focus ?? null,
							note: input.note ?? null,
						},
						executionMs: Date.now() - startedAt,
					}
				}
				if (call.name === 'edit_artifact') {
					const input = toolSchemas.edit_artifact.parse(call.arguments)
					const artifact = await projectsModule.getArtifactById(input.artifactId)
					if (!artifact) {
						return {
							success: false,
							tool: call.name,
							error: `Artifact ${input.artifactId} not found`,
							executionMs: Date.now() - startedAt,
						}
					}
					const ownership = await assertArtifactAccessible(artifact, userId)
					if (!ownership.ok) {
						return {
							success: false,
							tool: call.name,
							error: ownership.error,
							executionMs: Date.now() - startedAt,
						}
					}
					const newVersion = await projectsModule.editArtifact({
						artifactId: input.artifactId,
						content: input.content,
						changeNote: input.changeNote,
						editedBy: userId,
						sourceRunId: toolUserContext.getStore()?.runId ?? null,
					})
					return {
						success: true,
						tool: call.name,
						input: { ...input, content: `[${input.content.length} chars]` },
						result: {
							versionId: newVersion?.id,
							seq: newVersion?.seq,
							artifactId: input.artifactId,
						},
						executionMs: Date.now() - startedAt,
					}
				}
			}

			if (call.name === 'video_generate') {
				const input = toolSchemas.video_generate.parse(call.arguments)
				const { submitVideoGenJob, waitForVideoGenJob } = await import('$lib/llm/video-generation.server')
				const submitted = await submitVideoGenJob({
					model: input.model,
					prompt: input.prompt,
					resolution: input.resolution,
					aspectRatio: input.aspectRatio,
					durationSeconds: input.durationSeconds,
					seed: input.seed,
					generateAudio: input.generateAudio,
				})
				const final = await waitForVideoGenJob(submitted.jobId, {
					timeoutMs: input.timeoutSeconds * 1000,
					pollIntervalMs: 5000,
				})
				const completed = final.status === 'completed' && Array.isArray(final.unsignedUrls) && final.unsignedUrls.length > 0
				if (completed && typeof final.cost === 'number' && final.cost > 0) {
					try {
						const { logToolUsage } = await import('$lib/costs/usage')
						await logToolUsage({
							toolName: 'video_generate',
							provider: 'openrouter',
							unitType: 'second',
							units: input.durationSeconds,
							cost: final.cost,
							userId,
							runId: runId ?? null,
							metadata: { model: input.model, resolution: input.resolution, jobId: final.jobId },
						})
					} catch (err) {
						logger.warn('[tools] video_generate cost log failed', { err })
					}
				}
				return {
					success: completed,
					tool: call.name,
					input,
					result: {
						jobId: final.jobId,
						status: final.status,
						urls: final.unsignedUrls ?? [],
						pollUrl: completed ? null : `/api/video-jobs/${final.jobId}`,
						error: final.error ?? null,
						cost: final.cost ?? null,
					},
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'image_generate') {
				const input = toolSchemas.image_generate.parse(call.arguments)
				const result = await generateImage(input.prompt, input.model, input.size)
				// Record the generated image so it appears in the /artifacts feed.
				// Best-effort: failures here must NOT bubble up — the image was generated
				// successfully and the model needs to see the URL even if our audit insert
				// fails (DB hiccup, transient issue, …).
				try {
					const { recordGeneratedImage } = await import('$lib/images/images.server')
					const conversationId = await resolveConversationFromRunId(runId ?? null)
					await recordGeneratedImage({
						userId,
						conversationId,
						runId: runId ?? null,
						prompt: result.prompt,
						model: result.model,
						size: result.size,
						url: result.url,
						costUsd: result.cost,
					})
				} catch (err) {
					logger.warn('[tools] recordGeneratedImage failed (non-fatal)', { err })
				}
				return {
					success: true,
					tool: call.name,
					input,
					result,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'list_my_repos' || call.name === 'sync_my_repos') {
				const sourceControl = await import('$lib/source-control')
				if (call.name === 'list_my_repos') {
					const input = toolSchemas.list_my_repos.parse(call.arguments)
					const repos = await sourceControl.listImportedRepositories(userId)
					const filter = input.search?.toLowerCase() ?? null
					const filtered = filter
						? repos.filter(
								(r) => r.owner.toLowerCase().includes(filter) || r.name.toLowerCase().includes(filter),
							)
						: repos
					const limited = filtered.slice(0, input.limit ?? 50)
					return {
						success: true,
						tool: call.name,
						input,
						result: limited.map((r) => {
							const meta = (r.metadata ?? {}) as { htmlUrl?: string; private?: boolean; description?: string | null }
							return {
								id: r.id,
								provider: r.provider,
								owner: r.owner,
								name: r.name,
								defaultBranch: r.defaultBranch,
								cloneUrl: r.cloneUrl,
								htmlUrl: meta.htmlUrl ?? null,
								private: !!meta.private,
								description: meta.description ?? null,
								updatedAt: r.updatedAt,
							}
						}),
						executionMs: Date.now() - startedAt,
					}
				}
				if (call.name === 'sync_my_repos') {
					const input = toolSchemas.sync_my_repos.parse(call.arguments)
					const summary = await sourceControl.syncGithubReposForUser(userId, input)
					if (summary.errorMessage) {
						return {
							success: false,
							tool: call.name,
							error: summary.errorMessage,
							executionMs: Date.now() - startedAt,
						}
					}
					return {
						success: true,
						tool: call.name,
						input,
						result: { total: summary.total, inserted: summary.inserted, updated: summary.updated, skipped: summary.skipped },
						executionMs: Date.now() - startedAt,
					}
				}
			}

			if (call.name === 'push_branch' || call.name === 'create_pull_request') {
				// Defense-in-depth: chat-stream unions MANDATORY_APPROVAL_TOOLS into the
				// runtime's approval set so the loop pauses and the operator confirms before
				// these tools execute. We additionally refuse at the execution layer for runs
				// that have no approval surface (automation, sub-agent) — even if the runtime
				// were misconfigured to forward such a call, the tool itself fails closed.
				const ctx = toolUserContext.getStore()
				if (!ctx?.runId) {
					return {
						success: false,
						tool: call.name,
						error: `${call.name} requires an interactive chat run with an operator; this call has no run context.`,
						executionMs: Date.now() - startedAt,
					}
				}
				try {
					const { chatRuns } = await import('$lib/runs/runs.schema')
					const [runRow] = await db
						.select({ source: chatRuns.source })
						.from(chatRuns)
						.where(eq(chatRuns.id, ctx.runId))
						.limit(1)
					if (!runRow) {
						return {
							success: false,
							tool: call.name,
							error: `${call.name}: run not found.`,
							executionMs: Date.now() - startedAt,
						}
					}
					if (runRow.source !== 'chat_stream') {
						return {
							success: false,
							tool: call.name,
							error: `${call.name} cannot run in a ${runRow.source} context. It requires operator approval through an interactive chat run.`,
							executionMs: Date.now() - startedAt,
						}
					}
				} catch (err) {
					return {
						success: false,
						tool: call.name,
						error: `${call.name}: failed to verify approval surface (${err instanceof Error ? err.message : String(err)})`,
						executionMs: Date.now() - startedAt,
					}
				}

				const sourceControl = await import('$lib/source-control')
				const conn = await sourceControl.getActiveGithubConnection(userId)
				if (!conn) {
					return {
						success: false,
						tool: call.name,
						error: 'No active GitHub connection. Connect at /source-control before pushing or opening pull requests.',
						executionMs: Date.now() - startedAt,
					}
				}

				if (call.name === 'push_branch') {
					const input = toolSchemas.push_branch.parse(call.arguments)
					const absPath = safePath(input.path ?? '.')
					try {
						let branch = input.branch
						if (!branch) {
							const { defaultGitRunner } = await import('$lib/workspace/worktree.server')
							const headResult = await defaultGitRunner(['-C', absPath, 'symbolic-ref', '--short', 'HEAD'])
							if (headResult.code !== 0) {
								return {
									success: false,
									tool: call.name,
									error: `Could not detect current branch (${headResult.stderr.trim() || 'detached HEAD?'}). Pass an explicit branch.`,
									executionMs: Date.now() - startedAt,
								}
							}
							branch = headResult.stdout.trim()
						}
						const { pushBranchToGithub } = await import('$lib/source-control/git-push.server')
						const pushResult = await pushBranchToGithub({
							repoPath: absPath,
							owner: input.owner,
							repo: input.repo,
							branch,
							token: conn.accessToken,
							force: input.force ?? false,
						})
						if (!pushResult.success) {
							return {
								success: false,
								tool: call.name,
								input: { ...input, branch },
								error: `git push failed (exit ${pushResult.exitCode}): ${pushResult.stderr.trim() || pushResult.stdout.trim()}`,
								executionMs: Date.now() - startedAt,
							}
						}
						return {
							success: true,
							tool: call.name,
							input: { ...input, branch },
							result: {
								branch: pushResult.branch,
								remote: pushResult.remote,
								stdout: pushResult.stdout,
								stderr: pushResult.stderr,
							},
							executionMs: Date.now() - startedAt,
						}
					} catch (err) {
						return {
							success: false,
							tool: call.name,
							error: err instanceof Error ? err.message : String(err),
							executionMs: Date.now() - startedAt,
						}
					}
				}

				// create_pull_request
				const input = toolSchemas.create_pull_request.parse(call.arguments)
				try {
					const { createPullRequest } = await import('$lib/source-control/github-api.server')
					const pr = await createPullRequest(conn.accessToken, {
						owner: input.owner,
						repo: input.repo,
						title: input.title,
						body: input.body,
						head: input.head,
						base: input.base,
						draft: input.draft ?? true,
					})
					// Persist the PR to source-control schema if we have an attached repo row.
					let recordedId: string | null = null
					try {
						const repos = await sourceControl.listRepositories(userId)
						const matched = repos.find(
							(r) => r.owner.toLowerCase() === input.owner.toLowerCase() && r.name.toLowerCase() === input.repo.toLowerCase(),
						)
						if (matched) {
							const recorded = await sourceControl.recordPullRequest({
								repositoryId: matched.id,
								providerPrNumber: pr.number,
								title: input.title,
								body: input.body ?? null,
								headBranch: input.head,
								baseBranch: input.base,
								status: pr.draft ? 'draft' : pr.state === 'closed' ? 'closed' : 'open',
								runId: toolUserContext.getStore()?.runId ?? null,
								createdBy: userId,
								providerUrl: pr.htmlUrl,
								metadata: { source: 'agent' },
							})
							recordedId = recorded.id
						}
					} catch (err) {
						logger.warn('[create_pull_request] recordPullRequest failed (non-fatal)', { err })
					}
					// Wave 5 #19 phase 4 — review-inbox handoff. Best-effort: a failed insert
					// never blocks the agent's report-back to the user. DedupeKey ensures a single
					// open row per (owner, repo, prNumber) even if the agent retries.
					void (async () => {
						try {
							const { openReviewItem } = await import('$lib/observability/review.server')
							await openReviewItem({
								type: 'pull_request_ready',
								severity: 'info',
								summary: `PR opened: ${input.owner}/${input.repo}#${pr.number} — ${input.title.slice(0, 120)}`,
								payload: {
									kind: 'pull_request',
									owner: input.owner,
									repo: input.repo,
									prNumber: pr.number,
									htmlUrl: pr.htmlUrl,
									draft: pr.draft,
									head: input.head,
									base: input.base,
									recordedId,
									userId,
								},
								runId: toolUserContext.getStore()?.runId ?? null,
								dedupeKey: `pull_request:${input.owner}/${input.repo}:${pr.number}`,
							})
						} catch (err) {
							logger.warn('[create_pull_request] review-inbox handoff failed (non-fatal)', { err })
						}
					})()
					return {
						success: true,
						tool: call.name,
						input,
						result: {
							number: pr.number,
							htmlUrl: pr.htmlUrl,
							state: pr.state,
							draft: pr.draft,
							recordedId,
						},
						executionMs: Date.now() - startedAt,
					}
				} catch (err) {
					return {
						success: false,
						tool: call.name,
						input,
						error: err instanceof Error ? err.message : String(err),
						executionMs: Date.now() - startedAt,
					}
				}
			}

			if (call.name === 'list_pull_requests') {
				const input = toolSchemas.list_pull_requests.parse(call.arguments)
				const sourceControl = await import('$lib/source-control')
				const repos = await sourceControl.listRepositories(userId)
				const matched = repos.find(
					(r) => r.owner.toLowerCase() === input.owner.toLowerCase() && r.name.toLowerCase() === input.repo.toLowerCase(),
				)
				if (!matched) {
					return {
						success: false,
						tool: call.name,
						input,
						error: `Repository ${input.owner}/${input.repo} is not synced for this user. Run sync_my_repos first.`,
						executionMs: Date.now() - startedAt,
					}
				}
				const prs = await sourceControl.listPullRequestsForRepository(matched.id)
				const limit = input.limit ?? 50
				return {
					success: true,
					tool: call.name,
					input,
					result: prs.slice(0, limit).map((pr) => ({
						id: pr.id,
						providerPrNumber: pr.providerPrNumber,
						title: pr.title,
						status: pr.status,
						headBranch: pr.headBranch,
						baseBranch: pr.baseBranch,
						providerUrl: pr.providerUrl,
						runId: pr.runId,
						createdBy: pr.createdBy,
						createdAt: pr.createdAt,
						updatedAt: pr.updatedAt,
					})),
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'get_pull_request') {
				const input = toolSchemas.get_pull_request.parse(call.arguments)
				const sourceControl = await import('$lib/source-control')
				const pr = await sourceControl.getPullRequestById(input.pullRequestId)
				if (!pr) {
					return {
						success: true,
						tool: call.name,
						input,
						result: null,
						executionMs: Date.now() - startedAt,
					}
				}
				// Authorization check: the PR must belong to a repo the user owns.
				const repos = await sourceControl.listRepositories(userId)
				const owns = repos.some((r) => r.id === pr.repositoryId)
				if (!owns) {
					return {
						success: false,
						tool: call.name,
						input,
						error: `Pull request ${input.pullRequestId} is not visible to this user.`,
						executionMs: Date.now() - startedAt,
					}
				}
				return {
					success: true,
					tool: call.name,
					input,
					result: pr,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'clone_repository') {
				const input = toolSchemas.clone_repository.parse(call.arguments)
				const sourceControl = await import('$lib/source-control')
				const owns = (await sourceControl.listRepositories(userId)).find(
					(r) => r.owner.toLowerCase() === input.owner.toLowerCase() && r.name.toLowerCase() === input.repo.toLowerCase(),
				)
				if (!owns) {
					return {
						success: false,
						tool: call.name,
						input,
						error: `Repository ${input.owner}/${input.repo} is not connected for this user. Run sync_my_repos first.`,
						executionMs: Date.now() - startedAt,
					}
				}
				const conn = await sourceControl.getActiveGithubConnection(userId)
				if (!conn) {
					return {
						success: false,
						tool: call.name,
						input,
						error: 'No active GitHub connection. Connect at /source-control before cloning private repos.',
						executionMs: Date.now() - startedAt,
					}
				}
				const workspaceRoot = getWorkspace()
				// Mirror lives at `${workspace}/repos/<owner>/<repo>` so cleanup of the per-user
				// sandbox sweeps mirrors too. The path is bounded by safePathWithin so a hostile
				// owner/repo string cannot escape the workspace root even if it bypassed the
				// SAFE_SEGMENT regex (defense in depth).
				const mirrorRoot = safePath('repos')
				try {
					const { materializeRepoMirror } = await import('$lib/source-control/repo-mirror.server')
					const result = await materializeRepoMirror({
						mirrorRoot,
						owner: input.owner,
						repo: input.repo,
						defaultBranch: owns.defaultBranch,
						token: conn.accessToken,
					})
					return {
						success: true,
						tool: call.name,
						input,
						result: {
							path: result.path,
							fresh: result.fresh,
							branch: result.branch,
							workspaceRoot,
						},
						executionMs: Date.now() - startedAt,
					}
				} catch (err) {
					return {
						success: false,
						tool: call.name,
						input,
						error: err instanceof Error ? err.message : String(err),
						executionMs: Date.now() - startedAt,
					}
				}
			}

			if (call.name === 'prepare_commit') {
				const input = toolSchemas.prepare_commit.parse(call.arguments)
				const absPath = safePath(input.path ?? '.')
				const { prepareCommitDraft } = await import('$lib/source-control/git-local.server')
				try {
					const draft = await prepareCommitDraft(absPath)
					return {
						success: true,
						tool: call.name,
						input,
						result: draft,
						executionMs: Date.now() - startedAt,
					}
				} catch (err) {
					return {
						success: false,
						tool: call.name,
						input,
						error: err instanceof Error ? err.message : String(err),
						executionMs: Date.now() - startedAt,
					}
				}
			}

			if (call.name === 'update_agent') {
				const input = toolSchemas.update_agent.parse(call.arguments)
				const updated = await updateAgentRecord(input.agentId, {
					name: input.name,
					role: input.role,
					systemPrompt: input.systemPrompt,
					model: input.model,
				})
				if (!updated) {
					return {
						success: false,
						tool: call.name,
						error: 'Agent not found or no fields provided',
						executionMs: Date.now() - startedAt,
					}
				}
				return {
					success: true,
					tool: call.name,
					input,
					result: { id: updated.id, name: updated.name, status: updated.status },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'pause_agent') {
				const input = toolSchemas.pause_agent.parse(call.arguments)
				const updated = await setAgentStatus(input.agentId, 'paused')
				if (!updated) {
					return { success: false, tool: call.name, error: 'Agent not found', executionMs: Date.now() - startedAt }
				}
				return {
					success: true,
					tool: call.name,
					input,
					result: { id: updated.id, status: updated.status },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'resume_agent') {
				const input = toolSchemas.resume_agent.parse(call.arguments)
				const updated = await setAgentStatus(input.agentId, 'active')
				if (!updated) {
					return { success: false, tool: call.name, error: 'Agent not found', executionMs: Date.now() - startedAt }
				}
				return {
					success: true,
					tool: call.name,
					input,
					result: { id: updated.id, status: updated.status },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'create_automation') {
				const input = toolSchemas.create_automation.parse(call.arguments)
				const created = await createAutomationRecord({
					userId,
					agentId: input.agentId ?? null,
					description: input.description,
					cronExpression: input.cronExpression,
					prompt: input.prompt,
					enabled: input.enabled,
					conversationMode: input.conversationMode,
				})
				return {
					success: true,
					tool: call.name,
					input,
					result: created,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'list_automations') {
				const input = toolSchemas.list_automations.parse(call.arguments)
				const rows = await listAutomationsForUser(userId)
				return {
					success: true,
					tool: call.name,
					input,
					result: rows,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'update_automation') {
				const input = toolSchemas.update_automation.parse(call.arguments)
				const updated = await updateAutomationRecord(userId, input.automationId, {
					agentId: input.agentId,
					description: input.description,
					cronExpression: input.cronExpression,
					prompt: input.prompt,
					enabled: input.enabled,
					conversationMode: input.conversationMode,
				})
				if (!updated) {
					return { success: false, tool: call.name, error: 'Automation not found', executionMs: Date.now() - startedAt }
				}
				return {
					success: true,
					tool: call.name,
					input,
					result: updated,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'delete_automation') {
				const input = toolSchemas.delete_automation.parse(call.arguments)
				await deleteAutomationRecord(userId, input.automationId)
				return {
					success: true,
					tool: call.name,
					input,
					result: { deleted: input.automationId },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'ask_user') {
				const input = toolSchemas.ask_user.parse(call.arguments)
				return {
					success: false,
					tool: call.name,
					input,
					error: 'ask_user must be handled by chat streaming flow and cannot run directly.',
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

			if (call.name === 'search_tools') {
				const input = toolSchemas.search_tools.parse(call.arguments)
				const ctx = toolUserContext.getStore()
				const hits = searchToolsRegistry(input.query, input.limit ?? 10)
				// Register matches into the per-run loaded set so they appear in the tools array
				// on the next round. Done via a callback the runtime exposes — the runtime owns
				// the actual Set and refreshes its computeTools() each round.
				const matchedNames = hits.map((h) => h.name)
				if (matchedNames.length > 0 && ctx?.runtime?.loadSearchableTools) {
					try {
						ctx.runtime.loadSearchableTools(matchedNames)
					} catch (err) {
						logger.warn('[search_tools] loadSearchableTools callback threw', { err })
					}
				}
				return {
					success: true,
					tool: call.name,
					input,
					result: {
						matches: hits.map((h) => ({ name: h.name, description: h.description })),
						note:
							matchedNames.length === 0
								? `No tools matched "${input.query}". Try different keywords or check the spelling.`
								: `Loaded ${matchedNames.length} tool${matchedNames.length === 1 ? '' : 's'} for the next round: ${matchedNames.join(', ')}. Call them on the next turn — they're now in your tools array.`,
					},
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'request_plan_approval') {
				const input = toolSchemas.request_plan_approval.parse(call.arguments)
				// Mandatory-approval tool — by the time the executor runs, the user has approved
				// in the inline card. Switch the conversation's bound agent to the implementer so
				// the next round runs under that agent.
				const ctx = toolUserContext.getStore()
				if (!ctx?.userId) {
					return {
						success: false,
						tool: call.name,
						error: 'request_plan_approval requires an authenticated userId in the tool execution context.',
						executionMs: Date.now() - startedAt,
					}
				}
				if (!ctx.runId) {
					return {
						success: false,
						tool: call.name,
						error: 'request_plan_approval can only run inside a chat run.',
						executionMs: Date.now() - startedAt,
					}
				}

				const projectsModule = await import('$lib/projects/projects.server')
				const artifact = await projectsModule.getArtifactById(input.artifactId)
				if (!artifact) {
					return {
						success: false,
						tool: call.name,
						error: `Artifact ${input.artifactId} not found`,
						executionMs: Date.now() - startedAt,
					}
				}

				const conversationId = await resolveConversationFromRunId(ctx.runId)
				if (!conversationId) {
					return {
						success: false,
						tool: call.name,
						error: 'Unable to resolve the conversation for this run.',
						executionMs: Date.now() - startedAt,
					}
				}
				if (artifact.conversationId && artifact.conversationId !== conversationId) {
					return {
						success: false,
						tool: call.name,
						error: 'Artifact does not belong to this conversation.',
						executionMs: Date.now() - startedAt,
					}
				}

				const { agents: agentsTable } = await import('$lib/agents/agents.schema')
				const [implementer] = await db
					.select({ id: agentsTable.id, name: agentsTable.name })
					.from(agentsTable)
					.where(eq(agentsTable.id, input.implementerAgentId))
					.limit(1)
				if (!implementer) {
					return {
						success: false,
						tool: call.name,
						error: `Implementer agent ${input.implementerAgentId} not found`,
						executionMs: Date.now() - startedAt,
					}
				}

				try {
					const { setConversationAgent } = await import('$lib/chat/agent-switch.server')
					const result = await setConversationAgent(conversationId, input.implementerAgentId, {
						userId: ctx.userId,
						approvedArtifactId: input.artifactId,
					})
					return {
						success: true,
						tool: call.name,
						input,
						result: {
							approved: true,
							switchedToAgentId: result.agentId,
							previousAgentId: result.previousAgentId,
							artifactId: input.artifactId,
							implementerName: implementer.name,
						},
						executionMs: Date.now() - startedAt,
					}
				} catch (err) {
					logger.error('[request_plan_approval] agent switch failed', { err })
					return {
						success: false,
						tool: call.name,
						error: err instanceof Error ? err.message : 'Agent switch failed',
						executionMs: Date.now() - startedAt,
					}
				}
			}

			if (call.name === 'run_code') {
				const input = toolSchemas.run_code.parse(call.arguments)
				const { runCodeTool } = await import('./run-code.server')
				try {
					const result = await runCodeTool({ code: input.code, timeoutMs: input.timeoutMs })
					return {
						success: result.exitCode === 0 && !result.timedOut,
						tool: call.name,
						input,
						result,
						error:
							result.timedOut
								? `run_code timed out after ${result.durationMs}ms`
								: result.exitCode !== 0
									? `run_code exited with code ${result.exitCode}: ${result.stderr.slice(-1000) || 'no stderr'}`
									: undefined,
						executionMs: Date.now() - startedAt,
					}
				} catch (err) {
					return {
						success: false,
						tool: call.name,
						input,
						error: err instanceof Error ? err.message : String(err),
						executionMs: Date.now() - startedAt,
					}
				}
			}

			if (call.name === 'git_status' || call.name === 'git_log' || call.name === 'git_diff') {
				const ctx = toolUserContext.getStore()
				if (!ctx?.worktree) {
					return {
						success: false,
						tool: call.name,
						error: `${call.name} is only available in a git-worktree workspace (configure agent.config.workspace.mode='worktree' with a repoPath).`,
						executionMs: Date.now() - startedAt,
					}
				}
				await ensureWorkspaceDir()
				const workspace = getWorkspace()
				try {
					if (call.name === 'git_status') {
						const result = await execFileAsync('git', ['-C', workspace, 'status', '--porcelain=v1', '-b'], {
							maxBuffer: 4 * 1024 * 1024,
							timeout: 30_000,
						})
						return {
							success: true,
							tool: call.name,
							input: {},
							result: { stdout: result.stdout, stderr: result.stderr },
							executionMs: Date.now() - startedAt,
						}
					}
					if (call.name === 'git_log') {
						const input = toolSchemas.git_log.parse(call.arguments)
						const args = [
							'-C',
							workspace,
							'log',
							`--max-count=${input.max}`,
							'--pretty=format:%h%x09%an%x09%ad%x09%s',
							'--date=short',
						]
						if (input.paths?.length) {
							args.push('--')
							for (const p of input.paths) args.push(safePath(p))
						}
						const result = await execFileAsync('git', args, {
							maxBuffer: 4 * 1024 * 1024,
							timeout: 30_000,
						})
						return {
							success: true,
							tool: call.name,
							input,
							result: { stdout: result.stdout, stderr: result.stderr },
							executionMs: Date.now() - startedAt,
						}
					}
					// git_diff
					const input = toolSchemas.git_diff.parse(call.arguments)
					const args = ['-C', workspace, 'diff']
					if (input.staged) args.push('--cached')
					if (input.ref) args.push(input.ref)
					if (input.paths?.length) {
						args.push('--')
						for (const p of input.paths) args.push(safePath(p))
					}
					const result = await execFileAsync('git', args, {
						maxBuffer: 8 * 1024 * 1024,
						timeout: 60_000,
					})
					return {
						success: true,
						tool: call.name,
						input,
						result: { stdout: result.stdout, stderr: result.stderr },
						executionMs: Date.now() - startedAt,
					}
				} catch (err: unknown) {
					const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
					return {
						success: false,
						tool: call.name,
						error: e.stderr ?? e.message ?? `${call.name} failed`,
						executionMs: Date.now() - startedAt,
					}
				}
			}

			if (call.name === 'run_subagent') {
				const input = toolSchemas.run_subagent.parse(call.arguments)
				const { chat: llmChat } = await import('$lib/llm/chat.server')
				const subagentMessages = [
					{
						role: 'system' as const,
						content: 'You are a focused subagent. Complete the given task and return a clear, concise result.',
					},
					{
						role: 'user' as const,
						content: input.context ? `Context: ${input.context}\n\nTask: ${input.task}` : `Task: ${input.task}`,
					},
				]
				const response = await llmChat(subagentMessages, 'anthropic/claude-sonnet-4')
				return {
					success: true,
					tool: call.name,
					input,
					result: response.content,
					executionMs: Date.now() - startedAt,
				}
			}

			return {
				success: false,
				tool: call.name,
				error: `Tool is not implemented: ${call.name}`,
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
		},
	)
}

export type AskUserQuestion = z.infer<typeof toolSchemas.ask_user>['questions'][number]
export type AskUserAnswers = Record<string, string>
