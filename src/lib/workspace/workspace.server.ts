import { mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { ensureWorktree, type GitRunner } from './worktree.server'

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const DEFAULT_SANDBOX_ROOT = '/workspace/users'

function sanitize(id: string, kind: string): string {
	if (!ID_PATTERN.test(id)) {
		throw new Error(`Invalid ${kind} for sandbox workspace: ${id}`)
	}
	return id
}

export type WorktreeConfig = {
	/** Absolute path of the source git repo to base the worktree on. */
	repoPath: string
	/** Branch to base the new worktree on. Defaults to the source repo's HEAD. */
	baseBranch?: string
	/** When true, also delete the run/<runId> branch on cleanup. Default: keep it. */
	deleteBranchOnCleanup?: boolean
}

export type WorkspaceContext = {
	userId: string
	/** Run ID — when present and no persistentKey, the workspace is run-scoped (ephemeral). */
	runId?: string | null
	/**
	 * Stable opt-in workspace key (Phase 2). When set, the workspace resolves to
	 * `${sandboxRoot}/<userId>/persistent/<key>/` and survives across runs. Use for
	 * long-running coding agents that want a stable repo checkout.
	 *
	 * Takes precedence over `runId` — if both are passed, the persistent path wins.
	 */
	persistentKey?: string | null
	/**
	 * Phase 4 of #7: when set together with `runId`, the workspace is materialized as a
	 * `git worktree add` of the source repo (a fresh `run/<runId>` branch off the base
	 * branch). Path: `${sandboxRoot}/<userId>/worktrees/<runId>`.
	 *
	 * Takes precedence over the regular run path. Mutually exclusive with `persistentKey` —
	 * if both are passed, the persistent path wins (matches the priority order in
	 * `resolveWorkspaceRoot`).
	 */
	worktree?: WorktreeConfig | null
	/**
	 * Absolute or relative path to the sandbox root directory. Pass the value of
	 * `$env/dynamic/private`'s `SANDBOX_WORKSPACE` here (the workspace module is
	 * SvelteKit-agnostic so unit tests can inject any root they want).
	 */
	sandboxRoot?: string
}

/**
 * Resolve the absolute root directory for a tool execution context.
 *
 * Resolution priority (most-specific wins):
 * - With `persistentKey`:        ${sandboxRoot}/<userId>/persistent/<key>   (Phase 2 — opt-in stable)
 * - Else with `worktree` + runId: ${sandboxRoot}/<userId>/worktrees/<runId> (Phase 4 — git worktree)
 * - Else with `runId`:            ${sandboxRoot}/<userId>/runs/<runId>      (Phase 1 — per-run isolation)
 * - Else:                          ${sandboxRoot}/<userId>                   (legacy path; back-compat for
 *   callers that haven't been migrated yet, e.g. ad-hoc/admin tool invocations outside a run loop)
 *
 * All four roots share a parent tree per user, so legacy persistent files at the user root
 * remain accessible to admin tooling but are invisible to ephemeral runs.
 */
export function resolveWorkspaceRoot(ctx: WorkspaceContext): string {
	const userId = sanitize(ctx.userId, 'userId')
	const root = ctx.sandboxRoot || DEFAULT_SANDBOX_ROOT
	if (ctx.persistentKey) {
		const key = sanitize(ctx.persistentKey, 'persistentKey')
		return resolve(root, userId, 'persistent', key)
	}
	if (ctx.worktree && ctx.runId) {
		const runId = sanitize(ctx.runId, 'runId')
		return resolve(root, userId, 'worktrees', runId)
	}
	if (ctx.runId) {
		const runId = sanitize(ctx.runId, 'runId')
		return resolve(root, userId, 'runs', runId)
	}
	return resolve(root, userId)
}

export function safePathWithin(workspaceRoot: string, userPath: string): string {
	const resolved = resolve(workspaceRoot, userPath)
	const rootWithSep = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`
	if (!(resolved === workspaceRoot || resolved.startsWith(rootWithSep))) {
		throw new Error(`Path escapes sandbox workspace: ${userPath}`)
	}
	return resolved
}

export async function ensureWorkspace(
	ctx: WorkspaceContext,
	gitRunner?: GitRunner,
): Promise<string> {
	const root = resolveWorkspaceRoot(ctx)
	if (ctx.worktree && ctx.runId && !ctx.persistentKey) {
		// git worktree add will create the leaf dir; ensureWorktree handles its parent.
		await ensureWorktree(
			{
				repoPath: ctx.worktree.repoPath,
				worktreePath: root,
				runId: ctx.runId,
				baseBranch: ctx.worktree.baseBranch,
			},
			gitRunner,
		)
		return root
	}
	await mkdir(root, { recursive: true })
	return root
}
