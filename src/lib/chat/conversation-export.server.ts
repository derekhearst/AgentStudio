/**
 * Loads a conversation for export (#18). Formatting is in ./conversation-export; this only
 * reads, and only the caller's own conversation — anyone else's is indistinguishable from one
 * that does not exist.
 */

import { and, asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { agents } from '$lib/agents/agents.schema'
import type { ExportInput } from '$lib/chat/conversation-export'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function loadConversationForExport(userId: string, conversationId: string): Promise<ExportInput | null> {
	if (!UUID_PATTERN.test(conversationId)) return null

	const [conversation] = await db
		.select({
			id: conversations.id,
			title: conversations.title,
			category: conversations.category,
			model: conversations.model,
			agentId: conversations.agentId,
			projectId: conversations.projectId,
			permissionMode: conversations.permissionMode,
			totalTokens: conversations.totalTokens,
			totalCost: conversations.totalCost,
			pinnedAt: conversations.pinnedAt,
			archivedAt: conversations.archivedAt,
			createdAt: conversations.createdAt,
			updatedAt: conversations.updatedAt,
		})
		.from(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.limit(1)
	if (!conversation) return null

	const [rows, [agent]] = await Promise.all([
		db
			.select({
				id: messages.id,
				sequence: messages.sequence,
				role: messages.role,
				content: messages.content,
				model: messages.model,
				parentMessageId: messages.parentMessageId,
				createdAt: messages.createdAt,
				tokensIn: messages.tokensIn,
				tokensOut: messages.tokensOut,
				cost: messages.cost,
				attachments: messages.attachments,
				metadata: messages.metadata,
				toolCalls: messages.toolCalls,
			})
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
			.orderBy(asc(messages.sequence)),
		conversation.agentId
			? db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.id, conversation.agentId)).limit(1)
			: Promise.resolve([]),
	])

	return { conversation, agent: agent ?? null, messages: rows }
}
