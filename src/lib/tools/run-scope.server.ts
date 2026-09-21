/**
 * Run-scope resolution for the tools dispatch layer.
 *
 * Extracted from the old `artifact-scope.server.ts` when the artifacts domain was
 * removed. This helper was never artifact-specific — media, meta and projects
 * handlers all use it to find the conversation a tool call belongs to.
 */

import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { logger } from '$lib/observability/logger'

/**
 * Resolve the conversation a tool call belongs to via the runId carried in the
 * AsyncLocalStorage context. Returns null when there is no run context — e.g. a
 * one-shot synthesis path that bypasses `chat_runs`.
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
