import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { type CapabilityGroup, capabilityGroups } from './tools'
import { mergeAlwaysOn } from './capabilities-core'

export { expandGroupsToToolNames, mergeAlwaysOn } from './capabilities-core'

export type EnableResult = {
	added: boolean
	enabledGroups: CapabilityGroup[]
	addedTools: string[]
}

/**
 * Read the currently enabled capability groups for a run. Always returns at least the alwaysOn
 * groups so callers can rely on `core` being present even if a misbehaving migration cleared the
 * column.
 */
export async function getEnabledGroups(runId: string): Promise<CapabilityGroup[]> {
	const [row] = await db
		.select({ enabledCapabilityGroups: chatRuns.enabledCapabilityGroups })
		.from(chatRuns)
		.where(eq(chatRuns.id, runId))
		.limit(1)
	const stored = (row?.enabledCapabilityGroups ?? []) as string[]
	return mergeAlwaysOn(stored)
}

/**
 * Idempotently add a capability group to a run's active set. Returns `added: false` if the group
 * was already enabled, plus the new enabled list so callers can echo it back to the model.
 *
 * Row-locked (`for update`) so two concurrent enables in the same run don't race.
 */
export async function enableGroupForRun(runId: string, group: CapabilityGroup): Promise<EnableResult> {
	if (!(group in capabilityGroups)) {
		throw new Error(`Unknown capability group: ${group}`)
	}
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({ enabledCapabilityGroups: chatRuns.enabledCapabilityGroups })
			.from(chatRuns)
			.where(eq(chatRuns.id, runId))
			.for('update')
		if (!row) {
			throw new Error(`enableGroupForRun: run ${runId} not found`)
		}
		const current = mergeAlwaysOn((row.enabledCapabilityGroups ?? []) as string[])
		if (current.includes(group)) {
			return { added: false, enabledGroups: current, addedTools: [] }
		}
		const next = [...current, group]
		await tx.update(chatRuns).set({ enabledCapabilityGroups: next }).where(eq(chatRuns.id, runId))
		return {
			added: true,
			enabledGroups: next,
			addedTools: [...capabilityGroups[group].tools],
		}
	})
}
