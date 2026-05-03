import { and, eq, or, isNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { contextSlotConfigs } from '$lib/context/context.schema'
import type { SlotOverride } from '$lib/context/slots.server'

/**
 * Load merged slot overrides for a given user (and optional agent).
 *
 * Precedence: agent-specific overrides win over user-wide (`agentId IS NULL`) overrides for the
 * same slot. The returned map can be passed to `applySlotOverrides(slots, map)` directly.
 */
export async function loadSlotOverrides(
	userId: string,
	agentId?: string | null,
): Promise<Record<string, SlotOverride>> {
	const rows = await db
		.select({
			agentId: contextSlotConfigs.agentId,
			slotName: contextSlotConfigs.slotName,
			tokenBudget: contextSlotConfigs.tokenBudget,
			priority: contextSlotConfigs.priority,
			enabled: contextSlotConfigs.enabled,
		})
		.from(contextSlotConfigs)
		.where(
			and(
				eq(contextSlotConfigs.userId, userId),
				agentId
					? or(eq(contextSlotConfigs.agentId, agentId), isNull(contextSlotConfigs.agentId))
					: isNull(contextSlotConfigs.agentId),
			),
		)

	// Apply user-wide first, then agent-specific, so agent-specific wins.
	const merged = new Map<string, SlotOverride>()
	const userWide = rows.filter((r) => r.agentId === null)
	const perAgent = rows.filter((r) => r.agentId !== null)
	for (const r of [...userWide, ...perAgent]) {
		merged.set(r.slotName, {
			tokenBudget: r.tokenBudget,
			priority: r.priority,
			enabled: r.enabled,
		})
	}
	return Object.fromEntries(merged)
}

export type SlotOverrideUpsert = {
	userId: string
	agentId?: string | null
	slotName: string
	tokenBudget?: number | null
	priority?: number | null
	enabled?: boolean
}

/**
 * Upsert a single slot override. agentId can be null for user-wide overrides.
 */
export async function upsertSlotOverride(input: SlotOverrideUpsert): Promise<void> {
	const now = new Date()
	await db
		.insert(contextSlotConfigs)
		.values({
			userId: input.userId,
			agentId: input.agentId ?? null,
			slotName: input.slotName,
			tokenBudget: input.tokenBudget ?? null,
			priority: input.priority ?? null,
			enabled: input.enabled ?? true,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [contextSlotConfigs.userId, contextSlotConfigs.agentId, contextSlotConfigs.slotName],
			set: {
				tokenBudget: input.tokenBudget ?? null,
				priority: input.priority ?? null,
				enabled: input.enabled ?? true,
				updatedAt: now,
			},
		})
}

export async function deleteSlotOverride(
	userId: string,
	agentId: string | null,
	slotName: string,
): Promise<void> {
	await db
		.delete(contextSlotConfigs)
		.where(
			and(
				eq(contextSlotConfigs.userId, userId),
				agentId === null ? isNull(contextSlotConfigs.agentId) : eq(contextSlotConfigs.agentId, agentId),
				eq(contextSlotConfigs.slotName, slotName),
			),
		)
}
