import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultGitRunner, type GitRunner } from '$lib/workspace/worktree.server'
import {
	buildDiffStatArgs,
	buildLogArgs,
	buildStatusArgs,
	parseGitDiffStatOutput,
	parseGitLogOutput,
	parseGitStatusOutput,
	suggestCommitSubject,
	type GitCommitSummary,
	type GitDiffStatSummary,
	type GitStatusSummary,
} from './git-local'

export type { GitCommitSummary }

/**
 * Wave 5 #19 phase 3 — server-side wrappers for the `git_status` + `prepare_commit` agent
 * tools. Both delegate path-bounding to the caller (the tool execution branch resolves
 * the user-supplied path through `safePathWithin`) and rely on the same `GitRunner`
 * abstraction the worktree primitives use, so a single fake runner covers all paths in
 * tests.
 */

async function isGitRepository(absPath: string): Promise<boolean> {
	try {
		const gitDir = await stat(join(absPath, '.git'))
		return gitDir.isDirectory() || gitDir.isFile() // worktrees write a .git file pointing at gitdir
	} catch {
		return false
	}
}

/**
 * Read recent commits from a local git clone. Used by the source-control page's repo
 * detail panel — falls back to an empty array when the path isn't a git repo (the UI
 * shows "Pull latest" in that state instead of an error toast).
 */
export async function listRecentCommits(
	absPath: string,
	opts: { limit: number } = { limit: 10 },
	runner: GitRunner = defaultGitRunner,
): Promise<GitCommitSummary[]> {
	if (!(await isGitRepository(absPath))) return []
	const result = await runner(buildLogArgs(absPath, opts))
	if (result.code !== 0) return []
	return parseGitLogOutput(result.stdout)
}

export async function gitStatusAt(
	absPath: string,
	runner: GitRunner = defaultGitRunner,
): Promise<GitStatusSummary> {
	if (!(await isGitRepository(absPath))) {
		throw new Error(`Path is not a git repository: ${absPath}`)
	}
	const args = buildStatusArgs(absPath)
	const result = await runner(args)
	if (result.code !== 0) {
		throw new Error(
			`git status failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
		)
	}
	return parseGitStatusOutput(result.stdout)
}

export type CommitDraft = {
	branch: string | null
	upstream: string | null
	ahead: number
	behind: number
	dirty: boolean
	diff: GitDiffStatSummary
	suggestedSubject: string
	files: GitStatusSummary['files']
}

/**
 * `prepare_commit` produces the structured payload an operator (or downstream
 * `create_pull_request` step) needs to draft a commit: branch + upstream context, working
 * tree status, diff summary against HEAD, and a deterministic subject suggestion. No write
 * side-effects; the agent is expected to present this to the user for approval before any
 * push or PR creation in a future phase.
 */
export async function prepareCommitDraft(
	absPath: string,
	runner: GitRunner = defaultGitRunner,
): Promise<CommitDraft> {
	if (!(await isGitRepository(absPath))) {
		throw new Error(`Path is not a git repository: ${absPath}`)
	}
	const [statusRaw, diffRaw] = await Promise.all([runner(buildStatusArgs(absPath)), runner(buildDiffStatArgs(absPath))])

	if (statusRaw.code !== 0) {
		throw new Error(
			`git status failed (exit ${statusRaw.code}): ${statusRaw.stderr.trim() || statusRaw.stdout.trim()}`,
		)
	}
	if (diffRaw.code !== 0) {
		throw new Error(
			`git diff --stat failed (exit ${diffRaw.code}): ${diffRaw.stderr.trim() || diffRaw.stdout.trim()}`,
		)
	}

	const status = parseGitStatusOutput(statusRaw.stdout)
	const diff = parseGitDiffStatOutput(diffRaw.stdout)
	return {
		branch: status.branch,
		upstream: status.upstream,
		ahead: status.ahead,
		behind: status.behind,
		dirty: status.dirty,
		diff,
		suggestedSubject: suggestCommitSubject(diff),
		files: status.files,
	}
}
