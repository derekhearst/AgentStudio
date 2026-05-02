/**
 * Public memory facade — the surface used by chat, agents, and the bench harness.
 */

import { eq, inArray } from 'drizzle-orm'
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
		.orderBy(messages.createdAt)

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
		return `${header}\n${drawer.content}`
	})
	return `<memory_context>\n${blocks.join('\n\n')}\n</memory_context>`
}

export { mineSession, mineSessions }
