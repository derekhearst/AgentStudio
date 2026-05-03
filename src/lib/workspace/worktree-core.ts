/**
 * Pure helpers for building git worktree commands. Has zero `node:` or SvelteKit
 * imports so unit tests can call into it without touching the filesystem or env.
 */

const SAFE_REF = /^[a-zA-Z0-9_/-]+$/

export type WorktreeRequest = {
	/** Absolute path of the source repo (the .git dir lives here). */
	repoPath: string
	/** Absolute path where the worktree should be created. Must NOT yet exist. */
	worktreePath: string
	/** Branch name to create off of `baseBranch`. Convention: `run/<runId>`. */
	branch: string
	/** Branch in the source repo to base the new branch on. Defaults to repo HEAD. */
	baseBranch?: string
}

export type WorktreeRemoveRequest = {
	repoPath: string
	worktreePath: string
	branch: string
	/** When true, also delete the branch after removing the worktree. */
	deleteBranch?: boolean
}

/**
 * Build the `git worktree add` argv. The result is `[exe, ...args]`-shaped — the caller
 * picks the executable and `cwd`. Branch defaults to `run/<derived>` if the consumer
 * wants; no implicit naming here, the request must supply it.
 */
export function buildWorktreeAddArgs(req: WorktreeRequest): string[] {
	assertSafeRef(req.branch, 'branch')
	if (req.baseBranch) assertSafeRef(req.baseBranch, 'baseBranch')
	const args = ['-C', req.repoPath, 'worktree', 'add', '-b', req.branch, req.worktreePath]
	if (req.baseBranch) args.push(req.baseBranch)
	return args
}

export function buildWorktreeRemoveArgs(req: { repoPath: string; worktreePath: string }): string[] {
	return ['-C', req.repoPath, 'worktree', 'remove', '--force', req.worktreePath]
}

export function buildBranchDeleteArgs(req: { repoPath: string; branch: string }): string[] {
	assertSafeRef(req.branch, 'branch')
	return ['-C', req.repoPath, 'branch', '-D', req.branch]
}

export function buildHeadBranchArgs(repoPath: string): string[] {
	return ['-C', repoPath, 'symbolic-ref', '--short', 'HEAD']
}

export function buildWorktreeListArgs(repoPath: string): string[] {
	return ['-C', repoPath, 'worktree', 'list', '--porcelain']
}

/**
 * Parse the porcelain output of `git worktree list --porcelain`. Each worktree is a
 * blank-line-separated record of `key value` lines; we only need `worktree` and `branch`.
 */
export function parseWorktreeList(porcelain: string): Array<{ path: string; branch: string | null }> {
	const records: Array<{ path: string; branch: string | null }> = []
	let current: { path?: string; branch?: string | null } | null = null
	for (const line of porcelain.split(/\r?\n/)) {
		if (line.length === 0) {
			if (current?.path) records.push({ path: current.path, branch: current.branch ?? null })
			current = null
			continue
		}
		if (!current) current = {}
		const space = line.indexOf(' ')
		const key = space >= 0 ? line.slice(0, space) : line
		const value = space >= 0 ? line.slice(space + 1) : ''
		if (key === 'worktree') current.path = value
		else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
		else if (key === 'detached') current.branch = null
	}
	if (current?.path) records.push({ path: current.path, branch: current.branch ?? null })
	return records
}

function assertSafeRef(value: string, kind: string): void {
	if (!value || !SAFE_REF.test(value)) {
		throw new Error(`Invalid ${kind} for git worktree (must match ${SAFE_REF}): ${value}`)
	}
}
