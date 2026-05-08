/**
 * Artifact ownership / scope checks used by the tools dispatch layer.
 *
 * Artifacts are either project-scoped (attached to a project the user owns) or
 * conversation-scoped (attached to a chat conversation the user owns). The
 * helpers below verify either path and return a Result-shaped value so the
 * dispatch site can surface the error back to the agent without throwing.
 *
 * Extracted from tools.server.ts to keep the dispatch surface focused on
 * tool-call dispatch and error mapping.
 */

import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { logger } from '$lib/observability/logger'

/**
 * Wave 4 #15 phase 2 finish — resolve the conversation that a tool call belongs to via
 * the runId in the AsyncLocalStorage context. Used by set_project_context to know which
 * `conversations` row to update. Returns null when there's no run-context (e.g. a tool
 * call from a one-shot synthesis path that bypasses chat_runs).
 */
export async function resolveConversationFromRunId(runId: string | null): Promise<string | null> {
	if (!runId) return null
	try {
		const { chatRuns } = await import('$lib/runs/runs.schema')
		const [row] = await db
			.select({ conversationId: chatRuns.conversationId })
			.from(chatRuns)
			.where(eq(chatRuns.id, runId))
			.limit(1)
		return row?.conversationId ?? null
	} catch (err) {
		logger.warn('[tools] resolveConversationFromRunId failed', { err })
		return null
	}
}

/**
 * Verify that the user owns the project (project-scoped) or conversation (conversation-scoped)
 * an artifact belongs to. Returns an OK marker (with project name when applicable) or an error
 * string the caller surfaces back to the agent.
 */
export async function assertArtifactAccessible(
	artifact: { projectId: string | null; conversationId: string | null; id: string },
	userId: string,
): Promise<{ ok: true; projectName: string | null } | { ok: false; error: string }> {
	if (artifact.projectId) {
		const projectsModule = await import('$lib/projects/projects.server')
		const project = await projectsModule.getProjectById(artifact.projectId)
		if (!project || project.userId !== userId) {
			return { ok: false, error: `Artifact ${artifact.id} not accessible` }
		}
		return { ok: true, projectName: project.name }
	}
	if (artifact.conversationId) {
		const { conversations } = await import('$lib/sessions/sessions.schema')
		const [conv] = await db
			.select({ userId: conversations.userId })
			.from(conversations)
			.where(eq(conversations.id, artifact.conversationId))
			.limit(1)
		if (!conv || conv.userId !== userId) {
			return { ok: false, error: `Artifact ${artifact.id} not accessible` }
		}
		return { ok: true, projectName: null }
	}
	return { ok: false, error: `Artifact ${artifact.id} has no scope` }
}
