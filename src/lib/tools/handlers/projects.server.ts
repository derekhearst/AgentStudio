/**
 * Projects tool handlers.
 *
 * `set_project_context` binds a project to the current conversation; the other two
 * handlers list and create projects. Each wraps the server-side projects domain
 * helpers with the standard validate-and-execute shape.
 *
 * Documents the agent produces are plain files in the project working directory,
 * so the filesystem tools cover them — nothing document-shaped lives here.
 */

import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { toolSchemas } from '../tool-schemas'
import { toolUserContext } from '../sandbox.server'
import { resolveConversationFromRunId } from '../run-scope.server'
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
}
