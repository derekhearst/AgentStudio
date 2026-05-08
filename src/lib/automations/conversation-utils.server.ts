import { and, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations } from '$lib/automations/automation.schema'
import { conversations } from '$lib/sessions/sessions.schema'

/**
 * Returns the conversation that an automation tick should write into. For `reuse` mode the
 * automation row carries a stable conversationId we re-open every time; for `new` mode (or
 * `reuse` with no row yet) we create a fresh conversation bound to the automation's owning
 * agent.
 *
 * Conversations require an agent (NOT NULL FK), so a no-agent automation falls back to the
 * user's default agent (resolved via `resolveDefaultAgentId`, which itself falls back to the
 * built-in Chat agent). When the automation is reuse-mode and we just created the
 * conversation, we write the new id back so the next tick re-opens it.
 */
export async function getOrCreateAutomationConversation(
	automation: typeof automations.$inferSelect,
) {
	if (automation.conversationMode === 'reuse' && automation.conversationId) {
		const [existing] = await db
			.select()
			.from(conversations)
			.where(
				and(
					eq(conversations.id, automation.conversationId),
					eq(conversations.userId, automation.userId),
				),
			)
			.limit(1)
		if (existing) return existing
	}

	const { resolveDefaultAgentId } = await import('$lib/chat/agent-switch.server')
	const agentId = await resolveDefaultAgentId(automation.userId, automation.agentId)
	if (!agentId) {
		throw new Error('No default agent configured. Re-run database bootstrap to seed built-in agents.')
	}
	const [created] = await db
		.insert(conversations)
		.values({
			title: automation.description,
			userId: automation.userId,
			agentId,
			model: 'anthropic/claude-sonnet-4',
		})
		.returning()

	if (automation.conversationMode === 'reuse') {
		await db
			.update(automations)
			.set({ conversationId: created.id, updatedAt: new Date() })
			.where(eq(automations.id, automation.id))
	}

	return created
}
