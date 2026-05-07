import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { agents } from '$lib/agents/agents.schema'
import { skills } from '$lib/skills/skills.schema'
import { chatWorkbenchPreferences, type WorkbenchPanelLayout } from '$lib/chat/chat.workbench.schema'
import { insertMessageWithSequence } from '$lib/chat/insert-message.server'
import { getBuiltinAgentId } from '$lib/agents/builtin-agents.server'

/**
 * Conversation agent persistence + workbench preferences.
 *
 * Replaces the prior `mode.server.ts`: a conversation is now bound to an agent (built-in
 * or user-created) instead of a mode enum. Switching the agent inserts a system anchor
 * message into history so the model's posture is unambiguous after compaction.
 */

export type WorkbenchPreferencesRow = {
	id: string
	userId: string
	defaultAgentId: string | null
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

export async function setDefaultAgent(userId: string, agentId: string): Promise<WorkbenchPreferencesRow> {
	await getWorkbenchPreferences(userId)
	const [updated] = await db
		.update(chatWorkbenchPreferences)
		.set({ defaultAgentId: agentId, updatedAt: new Date() })
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

export type AgentSwitchResult = {
	conversationId: string
	previousAgentId: string | null
	agentId: string
	anchorMessageId: string | null
}

/**
 * Update the conversation's bound agent. When the agent actually changes, write a system
 * anchor message into history so the model's posture is unambiguous after compaction. Anchor
 * text comes from `agents.anchor_prompt` (built-ins seed it) with a generic fallback for
 * user agents.
 */
export async function setConversationAgent(
	conversationId: string,
	agentId: string,
	options: { userId?: string } = {},
): Promise<AgentSwitchResult> {
	const [conversation] = await db
		.select({ id: conversations.id, agentId: conversations.agentId, userId: conversations.userId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1)

	if (!conversation) {
		throw new Error(`Conversation not found: ${conversationId}`)
	}
	if (options.userId && conversation.userId !== options.userId) {
		throw new Error('Conversation does not belong to the requesting user')
	}

	const previousAgentId = conversation.agentId

	if (previousAgentId === agentId) {
		return { conversationId, previousAgentId, agentId, anchorMessageId: null }
	}

	const [agent] = await db
		.select({ name: agents.name, role: agents.role, anchorPrompt: agents.anchorPrompt })
		.from(agents)
		.where(eq(agents.id, agentId))
		.limit(1)
	if (!agent) {
		throw new Error(`Agent not found: ${agentId}`)
	}

	const anchorContent =
		agent.anchorPrompt ?? `[Agent changed to ${agent.name}] You are now acting as ${agent.name}. ${agent.role}`

	const anchorMessageId = await db.transaction(async (tx) => {
		await tx
			.update(conversations)
			.set({ agentId, updatedAt: new Date() })
			.where(eq(conversations.id, conversationId))

		const anchor = await insertMessageWithSequence(
			{
				conversationId,
				role: 'system',
				content: anchorContent,
				metadata: { type: 'agent_anchor', previousAgentId, agentId },
			},
			tx,
		)
		return anchor.id
	})

	return { conversationId, previousAgentId, agentId, anchorMessageId }
}

/**
 * Resolve the agent id to use when creating a new conversation. Prefers an explicit choice,
 * falls back to the user's saved default, falls back to the built-in Chat agent. Returns
 * `null` only if the built-in seeder has never run (treated as a hard error by callers).
 */
export async function resolveDefaultAgentId(userId: string, explicit?: string | null): Promise<string | null> {
	if (explicit) return explicit
	const prefs = await getWorkbenchPreferences(userId)
	if (prefs.defaultAgentId) return prefs.defaultAgentId
	return getBuiltinAgentId(db, 'chat')
}

// Pure agent tool-policy helpers re-exported so existing call sites have a single import path.
export {
	resolveAgentToolPolicy,
	filterToolsByAgentPolicy,
	isToolAllowedByPolicy,
	type AgentToolPolicy,
} from './agent-tool-filter'

/**
 * Resolve the agent's effective identity content. Prefers the linked identity skill (so
 * `/skills/[id]` edits hot-reload without a deploy) and falls back to `agent.systemPrompt`
 * when the skill row is missing or disabled. Defense-in-depth — a misconfigured skill
 * row can never break the chat path.
 */
export async function loadAgentIdentityContent(agent: {
	systemPrompt: string
	identitySkillId: string | null
}): Promise<string> {
	if (!agent.identitySkillId) return agent.systemPrompt
	const [skill] = await db
		.select({ content: skills.content, enabled: skills.enabled })
		.from(skills)
		.where(eq(skills.id, agent.identitySkillId))
		.limit(1)
	if (skill && skill.enabled && skill.content.trim().length > 0) return skill.content
	return agent.systemPrompt
}
