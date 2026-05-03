import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import {
	buildBranchDeleteArgs,
	buildHeadBranchArgs,
	buildWorktreeAddArgs,
	buildWorktreeListArgs,
	buildWorktreeRemoveArgs,
	parseWorktreeList,
} from './worktree-core'

export type GitRunner = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>

/** Shell out to `git` with the supplied argv. Defined here once so callers can swap a fake in tests. */
export const defaultGitRunner: GitRunner = (args) =>
	new Promise((resolve, reject) => {
		const proc = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		proc.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8')
		})
		proc.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8')
		})
		proc.on('error', reject)
		proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }))
	})

export type EnsureWorktreeInput = {
	repoPath: string
	worktreePath: string
	runId: string
	baseBranch?: string
}

export type EnsureWorktreeResult = {
	created: boolean
	branch: string
	worktreePath: string
}

function branchForRun(runId: string): string {
	return `run/${runId}`
}

/**
 * Idempotently make sure a git worktree exists at `worktreePath`. If the path is
 * already a registered worktree of the source repo, returns `created: false` without
 * touching anything. Otherwise runs `git worktree add` to create it.
 *
 * Defaults base branch to `repoPath`'s current HEAD when not supplied — matches the
 * "branch off whatever the dev was working on" intuition for ad-hoc agents.
 */
export async function ensureWorktree(
	input: EnsureWorktreeInput,
	gitRunner: GitRunner = defaultGitRunner,
): Promise<EnsureWorktreeResult> {
	const branch = branchForRun(input.runId)

	// If the dir already exists AND is registered as a worktree of repoPath, no-op.
	const existing = await pathExists(input.worktreePath)
	if (existing) {
		const list = await listWorktrees(input.repoPath, gitRunner).catch(() => [])
		const match = list.find((w) => normalizePath(w.path) === normalizePath(input.worktreePath))
		if (match) return { created: false, branch: match.branch ?? branch, worktreePath: input.worktreePath }
		throw new Error(
			`worktreePath exists but is not a registered worktree of ${input.repoPath}: ${input.worktreePath}`,
		)
	}

	// Make sure the parent dir exists; git itself will create the leaf.
	await mkdir(dirname(input.worktreePath), { recursive: true })

	const baseBranch = input.baseBranch ?? (await detectHeadBranch(input.repoPath, gitRunner))
	const args = buildWorktreeAddArgs({
		repoPath: input.repoPath,
		worktreePath: input.worktreePath,
		branch,
		baseBranch,
	})
	const result = await gitRunner(args)
	if (result.code !== 0) {
		throw new Error(
			`git worktree add failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
		)
	}
	return { created: true, branch, worktreePath: input.worktreePath }
}

export type CleanupWorktreeInput = {
	repoPath: string
	worktreePath: string
	runId: string
	deleteBranch?: boolean
}

/**
 * Remove a worktree (idempotent — if the path or git registration is already gone, returns
 * `removed: false`). Optionally also deletes the branch — useful when the run was a throwaway
 * and there's no PR to leave the branch around for.
 *
 * Failures are surfaced as thrown errors so the GC caller can log and continue.
 */
export async function cleanupWorktree(
	input: CleanupWorktreeInput,
	gitRunner: GitRunner = defaultGitRunner,
): Promise<{ removed: boolean; branchDeleted: boolean }> {
	const list = await listWorktrees(input.repoPath, gitRunner).catch(() => [])
	const match = list.find((w) => normalizePath(w.path) === normalizePath(input.worktreePath))
	if (!match) {
		return { removed: false, branchDeleted: false }
	}

	const removeArgs = buildWorktreeRemoveArgs({
		repoPath: input.repoPath,
		worktreePath: input.worktreePath,
	})
	const removeResult = await gitRunner(removeArgs)
	if (removeResult.code !== 0) {
		throw new Error(
			`git worktree remove failed (exit ${removeResult.code}): ${removeResult.stderr.trim() || removeResult.stdout.trim()}`,
		)
	}

	let branchDeleted = false
	if (input.deleteBranch) {
		const branchArgs = buildBranchDeleteArgs({ repoPath: input.repoPath, branch: branchForRun(input.runId) })
		const branchResult = await gitRunner(branchArgs)
		// `branch -D` may legitimately fail if the branch was already pushed/deleted — log only.
		branchDeleted = branchResult.code === 0
	}

	return { removed: true, branchDeleted }
}

export async function listWorktrees(
	repoPath: string,
	gitRunner: GitRunner = defaultGitRunner,
): Promise<Array<{ path: string; branch: string | null }>> {
	const args = buildWorktreeListArgs(repoPath)
	const result = await gitRunner(args)
	if (result.code !== 0) {
		throw new Error(
			`git worktree list failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
		)
	}
	return parseWorktreeList(result.stdout)
}

export async function detectHeadBranch(repoPath: string, gitRunner: GitRunner = defaultGitRunner): Promise<string> {
	const args = buildHeadBranchArgs(repoPath)
	const result = await gitRunner(args)
	if (result.code !== 0) {
		throw new Error(
			`git symbolic-ref HEAD failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
		)
	}
	const branch = result.stdout.trim()
	if (!branch) throw new Error(`Cannot determine HEAD branch of ${repoPath} (detached?)`)
	return branch
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
}
