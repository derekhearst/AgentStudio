import { inArray } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { runWorkspaceGcCore, type GcSummary, type LookupRuns, type RunStatusForGc } from '$lib/workspace/gc-core'

export type { GcSummary, GcRunSummary } from '$lib/workspace/gc-core'

/**
 * Production GC entrypoint: scans the sandbox tree and removes ephemeral run workspaces that are
 * past TTL. Wraps `runWorkspaceGcCore` with a Drizzle-backed `lookupRuns`.
 */
export async function runWorkspaceGc(opts: {
	sandboxRoot: string
	ttlDays?: number
	dryRun?: boolean
	now?: Date
}): Promise<GcSummary> {
	const lookupRuns: LookupRuns = async (candidateRunIds: string[]) => {
		if (candidateRunIds.length === 0) return []
		const rows = await db
			.select({ id: chatRuns.id, state: chatRuns.state, finishedAt: chatRuns.finishedAt })
			.from(chatRuns)
			.where(inArray(chatRuns.id, candidateRunIds))
		return rows.map((r) => ({
			id: r.id,
			state: r.state as RunStatusForGc['state'],
			finishedAt: r.finishedAt,
		}))
	}
	return runWorkspaceGcCore({ ...opts, lookupRuns })
}
