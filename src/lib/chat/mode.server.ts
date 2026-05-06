import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations, type ChatMode } from '$lib/sessions/sessions.schema'
import { messages } from '$lib/sessions/sessions.schema'
import { chatWorkbenchPreferences, type WorkbenchPanelLayout } from '$lib/chat/chat.workbench.schema'
import { loadModeIdentitySkill } from '$lib/chat/mode-skills.server'
import { insertMessageWithSequence } from '$lib/chat/insert-message.server'

// Short anchor sentences inserted into the conversation history when the mode flips.
// Full posture guidance lives in the seeded mode-identity skills (loadModeIdentitySkill).
const ANCHOR_PROMPTS: Record<ChatMode, string> = {
	chat: '[Mode changed to Chat] You are now in Chat mode. Be conversational and collaborative. Keep responses concise; ask clarifying questions when intent is ambiguous.',
	research:
		'[Mode changed to Research] You are now in Research mode. Be a skeptical investigator. Cite sources for every factual claim, prefer primary references, and call out unknowns explicitly.',
	plan: '[Mode changed to Plan] You are now in Plan mode. Propose a structured plan with explicit success criteria and risk callouts before taking any actions. Wait for approval before executing.',
	agent: '[Mode changed to Agent] You are now in Agent mode. Execute autonomously with minimal interruptions. Report progress concisely; only stop for blocking decisions or hard failures.',
}

export type WorkbenchPreferencesRow = {
	id: string
	userId: string
	defaultMode: ChatMode
	showRightPanel: boolean
	panelLayout: WorkbenchPanelLayout | null
	createdAt: Date
	updatedAt: Date
}

export async function getWorkbenchPreferences(userId: string): Promise<WorkbenchPreferencesRow> {
	const [existing] = await db
		.select()
		.from(chatWorkbenchPreferences)
		.where(eq(chatWorkbenchPreferences.userId, userId))
		.limit(1)
	if (existing) return existing as WorkbenchPreferencesRow

	const [created] = await db
		.insert(chatWorkbenchPreferences)
		.values({ userId })
		.returning()
	return created as WorkbenchPreferencesRow
}

export async function setDefaultMode(userId: string, mode: ChatMode): Promise<WorkbenchPreferencesRow> {
	await getWorkbenchPreferences(userId)
	const [updated] = await db
		.update(chatWorkbenchPreferences)
		.set({ defaultMode: mode, updatedAt: new Date() })
		.where(eq(chatWorkbenchPreferences.userId, userId))
		.returning()
	return updated as WorkbenchPreferencesRow
}

export async function setShowRightPanel(userId: string, showRightPanel: boolean): Promise<WorkbenchPreferencesRow> {
	await getWorkbenchPreferences(userId)
	const [updated] = await db
		.update(chatWorkbenchPreferences)
		.set({ showRightPanel, updatedAt: new Date() })
		.where(eq(chatWorkbenchPreferences.userId, userId))
		.returning()
	return updated as WorkbenchPreferencesRow
}

export type ModeSwitchResult = {
	conversationId: string
	previousMode: ChatMode
	mode: ChatMode
	anchorMessageId: string | null
}

/**
 * Update a conversation's mode and, when the mode actually changed, write a system anchor
 * message into the conversation history so the model's posture is unambiguous after compaction.
 *
 * Returns the previous and new mode plus the anchor-message id (or null if mode was unchanged).
 */
export async function setConversationMode(
	conversationId: string,
	mode: ChatMode,
	options: { userId?: string } = {},
): Promise<ModeSwitchResult> {
	const [conversation] = await db
		.select({ id: conversations.id, mode: conversations.mode, userId: conversations.userId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1)

	if (!conversation) {
		throw new Error(`Conversation not found: ${conversationId}`)
	}
	if (options.userId && conversation.userId !== options.userId) {
		throw new Error('Conversation does not belong to the requesting user')
	}

	const previousMode = conversation.mode

	if (previousMode === mode) {
		return { conversationId, previousMode, mode, anchorMessageId: null }
	}

	const anchorContent = ANCHOR_PROMPTS[mode]
	const result = await db.transaction(async (tx) => {
		await tx
			.update(conversations)
			.set({ mode, updatedAt: new Date() })
			.where(eq(conversations.id, conversationId))

		const anchor = await insertMessageWithSequence(
			{
				conversationId,
				role: 'system',
				content: anchorContent,
				metadata: { type: 'mode_anchor', previousMode, mode },
			},
			tx,
		)

		return anchor.id
	})

	return { conversationId, previousMode, mode, anchorMessageId: result }
}

/** Short one-liner used as the persisted anchor message text on mode flip. */
export function getModeAnchorPrompt(mode: ChatMode): string {
	return ANCHOR_PROMPTS[mode]
}

/** Full posture guidance for the active mode — pulls live from the seeded mode-identity skill. */
export async function getModePostureContent(mode: ChatMode): Promise<string> {
	return loadModeIdentitySkill(mode)
}

// Wave 5 #22 phase 7 — pure mode-aware tool filter lives in `mode-filter.ts` so the
// Playwright Node test runner can import it without pulling in $lib/db.server. We
// re-export here so existing call sites (chat-stream + agent-definition) don't change.
export { filterToolsByMode, isToolAllowedInMode, getReadOnlyToolNames } from './mode-filter'
