import { command, query } from '$app/server'
import { and, asc, desc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { agents } from '$lib/agents/agents.schema'
import { chatRuns, type PendingQuestionEntry } from '$lib/runs/runs.schema'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import {
	getWorkbenchPreferences as readWorkbenchPreferences,
	setDefaultAgent as writeDefaultAgent,
	setShowRightPanel as writeShowRightPanel,
	setConversationAgent as writeConversationAgent,
	resolveDefaultAgentId,
} from '$lib/chat/agent-switch.server'
import { BUILTIN_AGENT_KEYS } from '$lib/agents/builtin-agents.server'
import { insertMessageWithSequence } from '$lib/chat/insert-message.server'

const updateConversationMetaSchema = z.object({
	id: z.string().uuid(),
	title: z.string().trim().min(1).max(120).optional(),
	category: z.string().trim().min(1).max(60).optional(),
})

const createConversationSchema = z.object({
	title: z.string().trim().min(1).max(120),
	model: z.string().trim().min(1).max(120).optional(),
	agentId: z.string().uuid().optional(),
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

const savePartialAssistantSchema = z.object({
	conversationId: z.string().uuid(),
	content: z.string().trim().min(1),
	model: z.string().trim().min(1).max(120).optional(),
	toolCalls: z.array(z.record(z.string(), z.unknown())).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
})

export const getConversations = query(async () => {
	const user = requireAuthenticatedRequestUser()
	const activeStates = new Set(['queued', 'running', 'waiting_tool_approval', 'waiting_user_input'])
	const rows = await db
		.select()
		.from(conversations)
		.where(eq(conversations.userId, user.id))
		.orderBy(desc(conversations.updatedAt))
		.limit(50)

	const conversationIds = rows.map((row) => row.id)
	const lastMessages = conversationIds.length
		? await db
				.select()
				.from(messages)
				.where(eq(messages.role, 'assistant'))
				.orderBy(desc(messages.createdAt), desc(messages.id))
		: []

	const conversationIdSet = new Set(conversationIds)

	const activeRuns = conversationIds.length
		? await db
				.select({
					id: chatRuns.id,
					conversationId: chatRuns.conversationId,
					state: chatRuns.state,
					label: chatRuns.label,
					startedAt: chatRuns.startedAt,
					lastHeartbeatAt: chatRuns.lastHeartbeatAt,
					updatedAt: chatRuns.updatedAt,
					error: chatRuns.error,
				})
				.from(chatRuns)
				.where(and(eq(chatRuns.userId, user.id), isNull(chatRuns.finishedAt)))
				.orderBy(desc(chatRuns.updatedAt))
		: []

	const activeRunByConversation = new Map<string, (typeof activeRuns)[number]>()
	for (const run of activeRuns) {
		if (!conversationIdSet.has(run.conversationId)) continue
		if (!activeStates.has(run.state)) continue
		if (!activeRunByConversation.has(run.conversationId)) {
			activeRunByConversation.set(run.conversationId, run)
		}
	}

	return rows.map((conversation) => {
		const last = lastMessages.find((message) => message.conversationId === conversation.id)
		const activeRun = activeRunByConversation.get(conversation.id)
		return {
			...conversation,
			lastMessage: last?.content ?? null,
			activeRun: activeRun
				? {
						id: activeRun.id,
						state: activeRun.state,
						label: activeRun.label,
						startedAt: activeRun.startedAt,
						lastHeartbeatAt: activeRun.lastHeartbeatAt,
						updatedAt: activeRun.updatedAt,
						error: activeRun.error,
					}
				: null,
		}
	})
})

export const getConversation = query(conversationIdSchema, async (conversationId) => {
	const user = requireAuthenticatedRequestUser()
	const [conversation] = await db
		.select()
		.from(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
		.limit(1)

	if (!conversation) {
		return null
	}

	// Parallelize messages + active-run lookup — both are scoped to the now-verified conversation.
	const [rows, [activeRun]] = await Promise.all([
		db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
			.orderBy(asc(messages.sequence)),
		db
			.select({
				id: chatRuns.id,
				state: chatRuns.state,
				pendingQuestions: chatRuns.pendingQuestions,
			})
			.from(chatRuns)
			.where(
				and(
					eq(chatRuns.conversationId, conversationId),
					eq(chatRuns.userId, user.id),
					isNull(chatRuns.finishedAt),
				),
			)
			.orderBy(desc(chatRuns.updatedAt))
			.limit(1),
	])

	// Surface the first un-decided ask_user entry so a hard refresh during a paused question
	// can resume — the stream path owns updates while connected; this is the resume seed.
	const undecided = (activeRun?.pendingQuestions ?? []).find(
		(entry): entry is PendingQuestionEntry => !!entry?.token && !entry.decidedAt,
	)
	const pendingAskUser = undecided
		? { token: undecided.token, questions: undecided.questions ?? [] }
		: null

	return {
		conversation,
		messages: rows,
		pendingAskUser,
	}
})

export const createConversation = command(createConversationSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const settings = await getOrCreateSettings(user.id)
	const agentId = await resolveDefaultAgentId(user.id, input.agentId)
	if (!agentId) {
		throw new Error('No default agent configured. Re-run database bootstrap to seed built-in agents.')
	}
	const [created] = await db
		.insert(conversations)
		.values({
			title: input.title,
			userId: user.id,
			agentId,
			model: input.model ?? settings.defaultModel,
		})
		.returning()

	return created
})

export const deleteConversation = command(conversationIdSchema, async (conversationId) => {
	const user = requireAuthenticatedRequestUser()
	await db.delete(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
	return { success: true }
})

export const editMessage = command(editMessageSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const [target] = await db.select().from(messages).where(eq(messages.id, input.messageId)).limit(1)
	if (!target || target.role !== 'user') {
		return { success: false, error: 'Message not found or not editable' as const }
	}

	const [conversation] = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(and(eq(conversations.id, target.conversationId), eq(conversations.userId, user.id)))
		.limit(1)
	if (!conversation) {
		return { success: false, error: 'Message not found or not editable' as const }
	}

	await db.update(messages).set({ content: input.content }).where(eq(messages.id, input.messageId))

	await db
		.delete(messages)
		.where(
			and(
				eq(messages.conversationId, target.conversationId),
				or(
					gt(messages.createdAt, target.createdAt),
					and(eq(messages.createdAt, target.createdAt), ne(messages.id, target.id)),
				),
			),
		)

	return { success: true as const, conversationId: target.conversationId }
})

export const deleteMessagesAfter = command(deleteMessagesAfterSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const [conversation] = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(and(eq(conversations.id, input.conversationId), eq(conversations.userId, user.id)))
		.limit(1)

	if (!conversation) {
		return { success: false, error: 'Message not found' as const }
	}

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

export const savePartialAssistant = command(savePartialAssistantSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const [conversation] = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(and(eq(conversations.id, input.conversationId), eq(conversations.userId, user.id)))
		.limit(1)

	if (!conversation) {
		return { success: false as const, error: 'Conversation not found' as const }
	}

	// Stamp the active run id into metadata so the stream's final-insert path can detect
	// this partial and update it in place (instead of producing a duplicate assistant row).
	// We pick the most recently started, still-active run for the conversation.
	const [activeRun] = await db
		.select({ id: chatRuns.id })
		.from(chatRuns)
		.where(
			and(
				eq(chatRuns.conversationId, input.conversationId),
				eq(chatRuns.userId, user.id),
				isNull(chatRuns.finishedAt),
			),
		)
		.orderBy(desc(chatRuns.startedAt), desc(chatRuns.id))
		.limit(1)

	const created = await insertMessageWithSequence({
		conversationId: input.conversationId,
		role: 'assistant',
		content: input.content,
		model: input.model ?? null,
		metadata: {
			partial: true,
			...(activeRun ? { runId: activeRun.id } : {}),
			...input.metadata,
		},
		toolCalls: input.toolCalls ?? [],
	})

	await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, input.conversationId))

	return { success: true as const, messageId: created.id }
})

export const getMessageStats = query(conversationIdSchema, async (conversationId) => {
	const user = requireAuthenticatedRequestUser()
	const [conversation] = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
		.limit(1)

	if (!conversation) {
		return []
	}

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
		.orderBy(asc(messages.sequence))

	return rows
})

export const updateConversationMeta = command(updateConversationMetaSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const updates: Record<string, unknown> = {}
	if (input.title !== undefined) updates.title = input.title
	if (input.category !== undefined) updates.category = input.category
	if (Object.keys(updates).length === 0) return { success: true as const }
	await db
		.update(conversations)
		.set(updates)
		.where(and(eq(conversations.id, input.id), eq(conversations.userId, user.id)))
	return { success: true as const }
})

const setConversationAgentSchema = z.object({
	conversationId: z.string().uuid(),
	agentId: z.string().uuid(),
})

const setDefaultAgentSchema = z.object({ agentId: z.string().uuid() })

const setShowRightPanelSchema = z.object({ showRightPanel: z.boolean() })

export const getWorkbenchPreferences = query(async () => {
	const user = requireAuthenticatedRequestUser()
	const prefs = await readWorkbenchPreferences(user.id)
	return {
		defaultAgentId: prefs.defaultAgentId,
		showRightPanel: prefs.showRightPanel,
		panelLayout: prefs.panelLayout,
		updatedAt: prefs.updatedAt,
	}
})

export const setDefaultAgent = command(setDefaultAgentSchema, async ({ agentId }) => {
	const user = requireAuthenticatedRequestUser()
	const prefs = await writeDefaultAgent(user.id, agentId)
	return { success: true as const, defaultAgentId: prefs.defaultAgentId }
})

export const setShowRightPanel = command(setShowRightPanelSchema, async ({ showRightPanel }) => {
	const user = requireAuthenticatedRequestUser()
	const prefs = await writeShowRightPanel(user.id, showRightPanel)
	return { success: true as const, showRightPanel: prefs.showRightPanel }
})

export const setConversationAgent = command(setConversationAgentSchema, async ({ conversationId, agentId }) => {
	const user = requireAuthenticatedRequestUser()
	const result = await writeConversationAgent(conversationId, agentId, { userId: user.id })
	return {
		success: true as const,
		previousAgentId: result.previousAgentId,
		agentId: result.agentId,
		anchorMessageId: result.anchorMessageId,
	}
})

/**
 * Picker feed for the chat composer dropdown. Built-ins first (in BUILTIN_AGENT_KEYS order),
 * then custom agents by createdAt asc. Selects only what the picker needs to render.
 */
export const listAgentsForPicker = query(async () => {
	requireAuthenticatedRequestUser()
	const builtinOrder = sql`CASE ${agents.builtinKey}
		WHEN ${BUILTIN_AGENT_KEYS[0]} THEN 0
		WHEN ${BUILTIN_AGENT_KEYS[1]} THEN 1
		WHEN ${BUILTIN_AGENT_KEYS[2]} THEN 2
		WHEN ${BUILTIN_AGENT_KEYS[3]} THEN 3
		ELSE 99
	END`
	return db
		.select({
			id: agents.id,
			name: agents.name,
			role: agents.role,
			builtinKey: agents.builtinKey,
			status: agents.status,
		})
		.from(agents)
		.orderBy(builtinOrder, asc(agents.createdAt))
})
