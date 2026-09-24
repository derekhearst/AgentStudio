import { command, query } from '$app/server'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
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
import { editUserMessage, truncateAfterMessage } from '$lib/chat/message-branch.server'
import { previewMessageRewind } from '$lib/chat/rewind.server'
import { listRecentConversations } from '$lib/chat/conversation-list.server'
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

/**
 * #24 — `restoreFiles` also restores the files the dropped turns changed, before any row
 * changes; `acknowledgeUncommitted` is the user's explicit "overwrite them" for an imported
 * repository with uncommitted changes in those files. See `./message-branch.server`.
 */
const branchOptions = {
	restoreFiles: z.boolean().optional(),
	acknowledgeUncommitted: z.boolean().optional(),
}

const editMessageSchema = z.object({
	messageId: z.string().uuid(),
	content: z.string().trim().min(1),
	...branchOptions,
})

const deleteMessagesAfterSchema = z.object({
	conversationId: z.string().uuid(),
	messageId: z.string().uuid(),
	...branchOptions,
})

const previewRewindSchema = z.object({ messageId: z.string().uuid() })

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
	return editUserMessage({ ...input, userId: user.id })
})

export const deleteMessagesAfter = command(deleteMessagesAfterSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	return truncateAfterMessage({ ...input, userId: user.id })
})

/**
 * #24 — what "also restore files" would do for an edit or regenerate at `messageId`: the
 * files, their line counts and which have uncommitted changes. Changes nothing. A command
 * rather than a query: it starts a CLI process, and must never be cached or refreshed.
 */
export const previewRewind = command(previewRewindSchema, async ({ messageId }) => {
	const user = requireAuthenticatedRequestUser()
	return previewMessageRewind({ userId: user.id, messageId })
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
