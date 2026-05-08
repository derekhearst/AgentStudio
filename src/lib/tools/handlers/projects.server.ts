/**
 * Projects + Artifacts tool handlers.
 *
 * `set_project_context` binds a project to the current conversation. The remaining
 * handlers (list/create projects, list/read/create/edit/present artifacts) wrap the
 * server-side projects domain helpers with the standard validate-and-execute shape.
 *
 * Artifact handlers run an ownership check (`assertArtifactAccessible`) before
 * returning content so a hostile artifactId from a different user fails closed.
 */

import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { toolSchemas } from '../tool-schemas'
import { toolUserContext } from '../sandbox.server'
import { assertArtifactAccessible, resolveConversationFromRunId } from '../artifact-scope.server'
import type { ToolHandler } from '../handler-types'

export const projectsHandlers: Record<string, ToolHandler> = {
	set_project_context: async (call, { userId, startedAt }) => {
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
	},

	list_projects: async (call, { userId, startedAt }) => {
		toolSchemas.list_projects.parse(call.arguments)
		const projectsModule = await import('$lib/projects/projects.server')
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
	},

	create_project: async (call, { userId, startedAt }) => {
		const input = toolSchemas.create_project.parse(call.arguments)
		const projectsModule = await import('$lib/projects/projects.server')
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
	},

	list_artifacts: async (call, { userId, startedAt }) => {
		const input = toolSchemas.list_artifacts.parse(call.arguments)
		const projectsModule = await import('$lib/projects/projects.server')

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
			input.conversationId ??
			(await resolveConversationFromRunId(toolUserContext.getStore()?.runId ?? null))
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
	},

	read_artifact: async (call, { userId, startedAt }) => {
		const input = toolSchemas.read_artifact.parse(call.arguments)
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
	},

	create_artifact: async (call, { userId, startedAt }) => {
		const input = toolSchemas.create_artifact.parse(call.arguments)
		const projectsModule = await import('$lib/projects/projects.server')

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
	},

	present_artifact: async (call, { userId, startedAt }) => {
		const input = toolSchemas.present_artifact.parse(call.arguments)
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
	},

	edit_artifact: async (call, { userId, startedAt }) => {
		const input = toolSchemas.edit_artifact.parse(call.arguments)
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
	},
}
