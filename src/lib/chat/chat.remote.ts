import { command, query } from '$app/server'
import { and, asc, desc, eq, gt } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/server/db'
import { conversations, messages } from '$lib/server/db/schema'

const updateConversationMetaSchema = z.object({
	id: z.string().uuid(),
	title: z.string().trim().min(1).max(120).optional(),
	category: z.string().trim().min(1).max(60).optional(),
})

const createConversationSchema = z.object({
	title: z.string().trim().min(1).max(120),
	model: z.string().trim().min(1).max(120).optional(),
})

const conversationIdSchema = z.string().uuid()

const editMessageSchema = z.object({
	messageId: z.string().uuid(),
	content: z.string().trim().min(1),
})

const deleteMessagesAfterSchema = z.object({
	conversationId: z.string().uuid(),
	messageId: z.string().uuid(),
})

export const getConversations = query(async () => {
	const rows = await db.select().from(conversations).orderBy(desc(conversations.updatedAt)).limit(50)

	const conversationIds = rows.map((row) => row.id)
	const lastMessages = conversationIds.length
		? await db.select().from(messages).where(eq(messages.role, 'assistant')).orderBy(desc(messages.createdAt))
		: []

	return rows.map((conversation) => {
		const last = lastMessages.find((message) => message.conversationId === conversation.id)
		return {
			...conversation,
			lastMessage: last?.content ?? null,
		}
	})
})

export const getConversation = query(conversationIdSchema, async (conversationId) => {
	const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1)

	if (!conversation) {
		return null
	}

	const rows = await db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(asc(messages.createdAt))

	return {
		conversation,
		messages: rows,
	}
})

export const createConversation = command(createConversationSchema, async (input) => {
	const [created] = await db
		.insert(conversations)
		.values({
			title: input.title,
			model: input.model ?? 'anthropic/claude-sonnet-4',
		})
		.returning()

	return created
})

export const deleteConversation = command(conversationIdSchema, async (conversationId) => {
	await db.delete(conversations).where(eq(conversations.id, conversationId))
	return { success: true }
})

export const editMessage = command(editMessageSchema, async (input) => {
	const [target] = await db.select().from(messages).where(eq(messages.id, input.messageId)).limit(1)
	if (!target || target.role !== 'user') {
		return { success: false, error: 'Message not found or not editable' as const }
	}

	await db.update(messages).set({ content: input.content }).where(eq(messages.id, input.messageId))

	await db
		.delete(messages)
		.where(and(eq(messages.conversationId, target.conversationId), gt(messages.createdAt, target.createdAt)))

	return { success: true as const, conversationId: target.conversationId }
})

export const deleteMessagesAfter = command(deleteMessagesAfterSchema, async (input) => {
	const [pivot] = await db
		.select()
		.from(messages)
		.where(and(eq(messages.id, input.messageId), eq(messages.conversationId, input.conversationId)))
		.limit(1)

	if (!pivot) {
		return { success: false, error: 'Message not found' as const }
	}

	await db
		.delete(messages)
		.where(and(eq(messages.conversationId, input.conversationId), gt(messages.createdAt, pivot.createdAt)))

	return { success: true as const }
})

export const getMessageStats = query(conversationIdSchema, async (conversationId) => {
	const rows = await db
		.select({
			id: messages.id,
			role: messages.role,
			model: messages.model,
			tokensIn: messages.tokensIn,
			tokensOut: messages.tokensOut,
			cost: messages.cost,
			ttftMs: messages.ttftMs,
			totalMs: messages.totalMs,
			tokensPerSec: messages.tokensPerSec,
			createdAt: messages.createdAt,
		})
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(asc(messages.createdAt))

	return rows
})

export const updateConversationMeta = command(updateConversationMetaSchema, async (input) => {
	const updates: Record<string, unknown> = {}
	if (input.title !== undefined) updates.title = input.title
	if (input.category !== undefined) updates.category = input.category
	if (Object.keys(updates).length === 0) return { success: true as const }
	await db.update(conversations).set(updates).where(eq(conversations.id, input.id))
	return { success: true as const }
})
