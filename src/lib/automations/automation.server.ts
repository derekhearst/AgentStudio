import { and, asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations } from '$lib/automations/automation.schema'
import { agents } from '$lib/agents/agents.schema'
import { computeNextRunAt } from '$lib/automations/engine'
import { DEFAULT_TIMEZONE } from '$lib/automations/cron'

export async function listAutomationsForUser(userId: string) {
	return db
		.select({
			id: automations.id,
			description: automations.description,
			cronExpression: automations.cronExpression,
			timezone: automations.timezone,
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
	/** IANA zone the cron expression is read in. Defaults to `DEFAULT_TIMEZONE`. */
	timezone?: string
	prompt: string
	enabled?: boolean
	conversationMode?: 'new_each_run' | 'reuse'
	// Wave 5 #21 phase 4 — execution mode + output routing.
	mode?: 'chat_followup' | 'research' | 'maintenance'
	outputTarget?: 'chat_session' | 'review_inbox'
	// Wave 5 #21 phase 4 finish — code-mode target repository.
	repositoryId?: string | null
}) {
	const now = new Date()
	const timezone = input.timezone ?? DEFAULT_TIMEZONE
	const nextRunAt = computeNextRunAt(input.cronExpression, now, timezone)
	const [created] = await db
		.insert(automations)
		.values({
			userId: input.userId,
			agentId: input.agentId ?? null,
			description: input.description,
			cronExpression: input.cronExpression,
			timezone,
			prompt: input.prompt,
			enabled: input.enabled ?? true,
			conversationMode: input.conversationMode ?? 'new_each_run',
			mode: input.mode ?? 'chat_followup',
			outputTarget: input.outputTarget ?? 'chat_session',
			repositoryId: input.repositoryId ?? null,
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
		timezone?: string
		prompt?: string
		enabled?: boolean
		conversationMode?: 'new_each_run' | 'reuse'
		mode?: 'chat_followup' | 'research' | 'maintenance'
		outputTarget?: 'chat_session' | 'review_inbox'
		repositoryId?: string | null
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
	if (patch.mode !== undefined) updates.mode = patch.mode
	if (patch.outputTarget !== undefined) updates.outputTarget = patch.outputTarget
	if (patch.repositoryId !== undefined) updates.repositoryId = patch.repositoryId
	// The schedule is (expression, zone) — changing either one has to re-derive nextRunAt,
	// and each recompute needs the other half as it will be after this patch lands.
	if (patch.timezone !== undefined) updates.timezone = patch.timezone
	if (patch.cronExpression !== undefined) updates.cronExpression = patch.cronExpression
	if (patch.cronExpression !== undefined || patch.timezone !== undefined) {
		updates.nextRunAt = computeNextRunAt(
			patch.cronExpression ?? existing.cronExpression,
			new Date(),
			patch.timezone ?? existing.timezone ?? DEFAULT_TIMEZONE,
		)
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
