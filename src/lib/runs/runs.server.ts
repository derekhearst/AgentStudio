import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'

export const ACTIVE_CHAT_RUN_STATES = ['queued', 'running', 'waiting_tool_approval', 'waiting_user_input'] as const

export type ActiveChatRunState = (typeof ACTIVE_CHAT_RUN_STATES)[number]

export async function listActiveChatRunsForUser(userId: string) {
	const rows = await db
		.select({
			id: chatRuns.id,
			conversationId: chatRuns.conversationId,
			agentId: chatRuns.agentId,
			state: chatRuns.state,
			label: chatRuns.label,
			lastDelta: chatRuns.lastDelta,
			error: chatRuns.error,
			startedAt: chatRuns.startedAt,
			lastHeartbeatAt: chatRuns.lastHeartbeatAt,
			updatedAt: chatRuns.updatedAt,
		})
		.from(chatRuns)
		.where(
			and(eq(chatRuns.userId, userId), isNull(chatRuns.finishedAt), inArray(chatRuns.state, ACTIVE_CHAT_RUN_STATES)),
		)
		.orderBy(desc(chatRuns.updatedAt))

	const byConversation = new Map<string, (typeof rows)[number]>()
	for (const row of rows) {
		if (!byConversation.has(row.conversationId)) {
			byConversation.set(row.conversationId, row)
		}
	}
	return [...byConversation.values()]
}

export async function listActiveAgentRunsForUser(userId: string) {
	return db
		.select({
			id: chatRuns.id,
			conversationId: chatRuns.conversationId,
			agentId: chatRuns.agentId,
			state: chatRuns.state,
			label: chatRuns.label,
			lastDelta: chatRuns.lastDelta,
			startedAt: chatRuns.startedAt,
			lastHeartbeatAt: chatRuns.lastHeartbeatAt,
			updatedAt: chatRuns.updatedAt,
		})
		.from(chatRuns)
		.where(
			and(
				eq(chatRuns.userId, userId),
				inArray(chatRuns.state, ACTIVE_CHAT_RUN_STATES),
				isNull(chatRuns.finishedAt),
				isNotNull(chatRuns.agentId),
			),
		)
		.orderBy(desc(chatRuns.updatedAt))
}
