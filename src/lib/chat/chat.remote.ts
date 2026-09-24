import { command, query } from '$app/server'
import { error } from '@sveltejs/kit'
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
import { listArchivedConversations, listRecentConversations } from '$lib/chat/conversation-list.server'
import { setConversationArchivedForUser, setConversationPinnedForUser } from '$lib/chat/conversation-lifecycle.server'
import { scheduleMessageIndex, searchUserConversations } from '$lib/chat/message-search.server'
import { SEARCH_QUERY_MAX_CHARS, SEARCH_QUERY_MIN_CHARS } from '$lib/chat/conversation-search'
import { findLiveChatRun } from '$lib/runs/live-chat-run.server'
import {
	describePermissionMode,
	PERMISSION_MODES,
	requiresExplicitConfirm,
} from '$lib/engine/permission-mode'

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
	return listRecentConversations(user.id)
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
	const [rows, [activeRun], liveRunId] = await Promise.all([
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
		// The chat turn still running, which a reloaded page re-attaches to (#129).
		findLiveChatRun(conversationId, user.id),
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
		liveRunId,
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

	const [edited] = await db
		.update(messages)
		.set({ content: input.content })
		.where(eq(messages.id, input.messageId))
		.returning()
	// #18 — search finds the message by what it says now. The followers deleted below take
	// their search rows with them (cascade).
	scheduleMessageIndex(edited)

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

/**
 * #19 — per-conversation permission mode.
 *
 * `bypassPermissions` needs `confirmed: true`. The chat UI asks first, but the flag is
 * enforced here so the dangerous mode can never be set by a bare POST to the remote
 * function; everything else takes the default path.
 */
const setConversationPermissionModeSchema = z.object({
	conversationId: z.string().uuid(),
	mode: z.enum(PERMISSION_MODES),
	confirmed: z.boolean().optional(),
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

export const setConversationPermissionMode = command(
	setConversationPermissionModeSchema,
	async ({ conversationId, mode, confirmed }) => {
		const user = requireAuthenticatedRequestUser()
		if (requiresExplicitConfirm(mode) && confirmed !== true) {
			throw new Error(
				`Switching this conversation to "${mode}" needs an explicit confirmation. ${describePermissionMode(mode)}`,
			)
		}
		const updated = await db
			.update(conversations)
			.set({ permissionMode: mode, updatedAt: new Date() })
			.where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
			.returning({ id: conversations.id, permissionMode: conversations.permissionMode })
		if (updated.length === 0) throw new Error('Conversation not found')
		return { success: true as const, permissionMode: updated[0].permissionMode }
	},
)

/**
 * Clear the conversation's pinned checklist (#21).
 *
 * The panel has a dismiss because a finished list is clutter and an abandoned one is
 * misleading, and neither clears itself: `TodoWrite` only ever replaces a list, so without
 * this the last one a conversation ever wrote stays pinned forever. The next `TodoWrite`
 * writes a new one regardless — dismissing is about the panel, not about the agent's plan.
 */
export const clearConversationTodoList = command(conversationIdSchema, async (conversationId) => {
	const user = requireAuthenticatedRequestUser()
	const updated = await db
		.update(conversations)
		.set({ todoList: null })
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
		.returning({ id: conversations.id })
	if (updated.length === 0) throw new Error('Conversation not found')
	return { success: true as const }
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

/**
 * #18 — the archive: archived conversations, most recently archived first. Same row shape
 * as `getConversations`, which leaves them out.
 */
export const getArchivedConversations = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return listArchivedConversations(user.id)
})

const setConversationPinnedSchema = z.object({ id: z.string().uuid(), pinned: z.boolean() })

/** #18 — pin to the top of the sidebar, or unpin. Pinning an archived chat unarchives it. */
export const setConversationPinned = command(setConversationPinnedSchema, async ({ id, pinned }) => {
	const user = requireAuthenticatedRequestUser()
	const state = await setConversationPinnedForUser(user.id, id, pinned)
	if (!state) error(404, 'Conversation not found')
	return { success: true as const, ...state }
})

const setConversationArchivedSchema = z.object({ id: z.string().uuid(), archived: z.boolean() })

/**
 * #18 — archive (hide from the list, keep everything) or unarchive. The primary way to tidy
 * the sidebar; `deleteConversation` is the irreversible one. Archiving unpins.
 */
export const setConversationArchived = command(setConversationArchivedSchema, async ({ id, archived }) => {
	const user = requireAuthenticatedRequestUser()
	const state = await setConversationArchivedForUser(user.id, id, archived)
	if (!state) error(404, 'Conversation not found')
	return { success: true as const, ...state }
})

const searchConversationsSchema = z.object({
	q: z.string().trim().min(SEARCH_QUERY_MIN_CHARS).max(SEARCH_QUERY_MAX_CHARS),
	includeArchived: z.boolean().optional(),
})

/**
 * #18 — search the caller's conversations: message text and tool calls (file paths,
 * commands, links), plus titles. One hit per conversation with the best-matching snippet.
 */
export const searchConversations = query(searchConversationsSchema, async ({ q, includeArchived }) => {
	const user = requireAuthenticatedRequestUser()
	return searchUserConversations(user.id, q, { includeArchived: includeArchived === true })
})
