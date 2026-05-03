import { inArray } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'
import {
	runWorkspaceGcCore,
	type GcSummary,
	type LookupRuns,
	type RemoveWorktreeFn,
	type RunStatusForGc,
} from '$lib/workspace/gc-core'
import { defaultGitRunner } from '$lib/workspace/worktree.server'
import { buildWorktreeRemoveArgs } from '$lib/workspace/worktree-core'

export type { GcSummary, GcRunSummary } from '$lib/workspace/gc-core'

/**
 * Default worktree-deregistration hook for production GC. Runs `git -C <worktreePath> worktree
 * remove --force <worktreePath>` so the parent repo's bookkeeping is cleaned up before the bare
 * `rm -rf` falls back to deleting the directory itself. Idempotent: a non-zero exit (e.g. the
 * worktree was already removed) is swallowed so GC can proceed to the rm step.
 */
const defaultRemoveWorktree: RemoveWorktreeFn = async (worktreePath: string) => {
	const args = buildWorktreeRemoveArgs({ repoPath: worktreePath, worktreePath })
	const result = await defaultGitRunner(args)
	if (result.code !== 0) {
		throw new Error(
			`git worktree remove failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
		)
	}
}

/**
 * Production GC entrypoint: scans the sandbox tree and removes ephemeral run workspaces that are
 * past TTL. Wraps `runWorkspaceGcCore` with a Drizzle-backed `lookupRuns` and a real
 * `git worktree remove` hook for Phase 4 worktree paths.
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
	return runWorkspaceGcCore({ ...opts, lookupRuns, removeWorktree: defaultRemoveWorktree })
}
