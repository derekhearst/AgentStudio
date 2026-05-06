/**
 * Public memory facade — the surface used by chat, agents, and the bench harness.
 */

import { asc, eq, inArray } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { messages, conversations } from '$lib/sessions/sessions.schema'
import { memoryDrawers } from '$lib/memory/memory.schema'
import { mineSession, mineSessions, type MiningSession } from '$lib/memory/mining.server'
import { recall, type RecallOptions, type RetrievedDrawer } from '$lib/memory/retrieval.server'
import { rerank } from '$lib/memory/rerank.server'

export type { RetrievedDrawer, RecallOptions } from '$lib/memory/retrieval.server'

/** Mine the full message history of a single conversation into the palace. */
export async function mineConversation(opts: {
	conversationId: string
	userIdOverride?: string
}): Promise<{ drawerIds: string[]; wingIds: string[]; roomIds: string[]; closetIds: string[] }> {
	const [conversation] = await db.select().from(conversations).where(eq(conversations.id, opts.conversationId)).limit(1)
	if (!conversation) {
		return { drawerIds: [], wingIds: [], roomIds: [], closetIds: [] }
	}

	const userId = opts.userIdOverride ?? conversation.userId
	if (!userId) {
		return { drawerIds: [], wingIds: [], roomIds: [], closetIds: [] }
	}

	const messageRows = await db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, opts.conversationId))
		.orderBy(asc(messages.sequence))

	// Skip messages that have already been mined into a drawer.
	const messageIds = messageRows.map((row) => row.id)
	const minedIds = new Set<string>()
	if (messageIds.length > 0) {
		const existing = await db
			.select({ sourceMessageId: memoryDrawers.sourceMessageId })
			.from(memoryDrawers)
			.where(inArray(memoryDrawers.sourceMessageId, messageIds))
		for (const row of existing) {
			if (row.sourceMessageId) minedIds.add(row.sourceMessageId)
		}
	}

	const session: MiningSession = {
		conversationId: opts.conversationId,
		occurredAt: conversation.createdAt,
		sessionLabel: conversation.title ?? undefined,
		turns: messageRows
			.filter((row) => !minedIds.has(row.id))
			.filter((row) => row.role === 'user' || row.role === 'assistant' || row.role === 'system')
			.map((row) => ({
				role: row.role as 'user' | 'assistant' | 'system',
				content: typeof row.content === 'string' ? row.content : String(row.content ?? ''),
				sourceMessageId: row.id,
			}))
			.filter((turn) => turn.content.trim().length > 0),
	}

	return mineSession({
		userId,
		agentId: conversation.agentId ?? null,
		session,
	})
}

/** High-level recall used by chat — returns ranked drawers, optionally reranked. */
export async function recallForUser(
	userId: string,
	query: string,
	options: RecallOptions & { useRerank?: boolean; rerankModel?: string } = {},
): Promise<RetrievedDrawer[]> {
	const candidatePoolSize = options.candidatePoolSize ?? (options.useRerank ? 20 : 50)
	const initial = await recall(userId, query, {
		...options,
		topK: options.useRerank ? candidatePoolSize : (options.topK ?? 5),
		candidatePoolSize,
	})
	if (!options.useRerank) return initial
	return rerank(query, initial, {
		model: options.rerankModel,
		keepTopK: options.topK ?? 5,
	})
}

/** Render retrieved drawers as a `<memory_context>` system block for chat injection. */
export function renderMemoryContext(drawers: RetrievedDrawer[]): string {
	if (drawers.length === 0) return ''
	const blocks = drawers.map((drawer, i) => {
		const date = drawer.occurredAt.toISOString().slice(0, 10)
		const header = `[${i + 1}] ${date} · ${drawer.wingName} › ${drawer.closetTopic}`
		// Wave 4 #15 phase 3 — when a drawer is linked to a project artifact, surface the
		// linkage so the agent knows the memory is grounded in a specific artifact it can
		// load via read_artifact for full content.
		const linkLine = drawer.linkedArtifactId
			? `\n(linked artifact: ${drawer.linkedArtifactId})`
			: ''
		return `${header}\n${drawer.content}${linkLine}`
	})
	return `<memory_context>\n${blocks.join('\n\n')}\n</memory_context>`
}

/**
 * Wave 4 #15 phase 3 — Memory ↔ Projects bridge helper.
 *
 * Tag a drawer with a specific artifact reference so subsequent memory recalls can surface
 * the linked artifact alongside the drawer content. Pass `null` to clear the linkage.
 *
 * Application uses cases:
 *   - mining.server.ts: when mining a conversation bound to a project, scan drawer content
 *     for artifact references and tag matching drawers
 *   - manual API: a future remote endpoint or admin tool could let users tag drawers by hand
 *
 * Stale-pointer semantics: deleting the artifact does NOT cascade — the drawer keeps the
 * stale pointer, and `renderMemoryContext` shows it as `(linked artifact: <id>)`. The
 * application can detect the stale pointer by joining against artifacts.
 */
export async function linkDrawerToArtifact(
	drawerId: string,
	artifactId: string | null,
): Promise<{ updated: boolean }> {
	const { eq } = await import('drizzle-orm')
	const result = await db
		.update(memoryDrawers)
		.set({ linkedArtifactId: artifactId })
		.where(eq(memoryDrawers.id, drawerId))
		.returning({ id: memoryDrawers.id })
	return { updated: result.length > 0 }
}

export { mineSession, mineSessions }
