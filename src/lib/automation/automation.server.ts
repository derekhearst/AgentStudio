import { and, asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations } from '$lib/automation/automation.schema'
import { agents } from '$lib/agents/agents.schema'
import { computeNextRunAt } from '$lib/automation/engine'

export async function listAutomationsForUser(userId: string) {
	return db
		.select({
			id: automations.id,
			description: automations.description,
			cronExpression: automations.cronExpression,
			prompt: automations.prompt,
			enabled: automations.enabled,
			conversationMode: automations.conversationMode,
			conversationId: automations.conversationId,
			lastRunAt: automations.lastRunAt,
			nextRunAt: automations.nextRunAt,
			createdAt: automations.createdAt,
			updatedAt: automations.updatedAt,
			agentId: automations.agentId,
			agentName: agents.name,
		})
		.from(automations)
		.leftJoin(agents, eq(agents.id, automations.agentId))
		.where(eq(automations.userId, userId))
		.orderBy(asc(automations.createdAt))
}

export async function createAutomationRecord(input: {
	userId: string
	agentId?: string | null
	description: string
	cronExpression: string
	prompt: string
	enabled?: boolean
	conversationMode?: 'new_each_run' | 'reuse'
}) {
	const now = new Date()
	const nextRunAt = computeNextRunAt(input.cronExpression, now)
	const [created] = await db
		.insert(automations)
		.values({
			userId: input.userId,
			agentId: input.agentId ?? null,
			description: input.description,
			cronExpression: input.cronExpression,
			prompt: input.prompt,
			enabled: input.enabled ?? true,
			conversationMode: input.conversationMode ?? 'new_each_run',
			nextRunAt,
			updatedAt: now,
		})
		.returning()

	return created
}

export async function updateAutomationRecord(
	userId: string,
	automationId: string,
	patch: {
		agentId?: string | null
		description?: string
		cronExpression?: string
		prompt?: string
		enabled?: boolean
		conversationMode?: 'new_each_run' | 'reuse'
	},
) {
	const [existing] = await db
		.select()
		.from(automations)
		.where(and(eq(automations.id, automationId), eq(automations.userId, userId)))
		.limit(1)
	if (!existing) return null

	const updates: Partial<typeof automations.$inferInsert> = {
		updatedAt: new Date(),
	}

	if (patch.agentId !== undefined) updates.agentId = patch.agentId
	if (patch.description !== undefined) updates.description = patch.description
	if (patch.prompt !== undefined) updates.prompt = patch.prompt
	if (patch.enabled !== undefined) updates.enabled = patch.enabled
	if (patch.conversationMode !== undefined) updates.conversationMode = patch.conversationMode
	if (patch.cronExpression !== undefined) {
		updates.cronExpression = patch.cronExpression
		updates.nextRunAt = computeNextRunAt(patch.cronExpression)
	}

	const [updated] = await db
		.update(automations)
		.set(updates)
		.where(and(eq(automations.id, automationId), eq(automations.userId, userId)))
		.returning()
	return updated
}

export async function deleteAutomationRecord(userId: string, automationId: string) {
	await db.delete(automations).where(and(eq(automations.id, automationId), eq(automations.userId, userId)))
	return { success: true as const }
}
