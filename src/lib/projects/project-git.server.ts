import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { projects, type ProjectRow } from './projects.schema'
import { repositories, type RepositoryRow } from '$lib/source-control/source-control.schema'
import { runGit } from '$lib/source-control/git-exec.server'
import { assertSafeRevision } from '$lib/source-control/git-exec'
import { describeCloneRefresh, type CloneRefreshOutcome } from '$lib/source-control/repo-mirror'
import {
	gitStatusAt,
	listRecentCommits,
	prepareCommitDraft,
	type CommitDraft,
	type GitCommitSummary,
} from '$lib/source-control/git-local.server'
import { pushBranchToGithub, type PushBranchResult } from '$lib/source-control/git-push.server'
import { getProjectPath, fetchProjectRemote } from './project-fs.server'
import { getActiveGithubConnection } from '$lib/source-control/source-control.server'
import { GITHUB_RECONNECT_MESSAGE } from '$lib/source-control/github-oauth'

/**
 * Project-aware wrappers around the existing git primitives. The agent + UI layer should
 * route through these so they don't need to know about the underlying source-control
 * helpers — pass a `(userId, projectId)` and we resolve the on-disk path, the sidecar
 * `repositories` row (if any), and the OAuth token to authenticate remote operations.
 *
 * No DB mutations live here except `pullProject`'s `last_pulled_at` stamp; everything else
 * is a thin read on the working copy.
 */

// No leading `-` in either: git would read the value as an option.
const SAFE_BRANCH = /^(?!-)[a-zA-Z0-9_/-]+$/
const SAFE_REF = /^(?!-)[a-zA-Z0-9_/-]+$/

export type ProjectWithRepo = {
	project: ProjectRow
	repository: RepositoryRow | null
	path: string
}

async function loadProjectAndRepo(userId: string, projectId: string): Promise<ProjectWithRepo> {
	const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	if (!project) throw new Error(`Project ${projectId} not found`)
	if (project.userId !== userId) throw new Error('Not authorized for this project')
	if (project.repoKind === 'none') {
		throw new Error('This project has no repository on disk. Initialize it as local or import a remote.')
	}
	const [repository] = await db
		.select()
		.from(repositories)
		.where(eq(repositories.projectId, projectId))
		.limit(1)
	const path = project.repoLocalPath ?? getProjectPath(userId, projectId)
	return { project, repository: repository ?? null, path }
}

export async function getProjectStatus(userId: string, projectId: string) {
	const { path } = await loadProjectAndRepo(userId, projectId)
	return gitStatusAt(path)
}

export async function listProjectCommits(
	userId: string,
	projectId: string,
	opts: { limit?: number } = {},
): Promise<GitCommitSummary[]> {
	const { path } = await loadProjectAndRepo(userId, projectId)
	return listRecentCommits(path, { limit: opts.limit ?? 20 })
}

export async function prepareProjectCommit(userId: string, projectId: string): Promise<CommitDraft> {
	const { path } = await loadProjectAndRepo(userId, projectId)
	return prepareCommitDraft(path)
}

/**
 * Stage and commit the working tree. When `paths` is supplied, only those paths are added
 * (like `git add -- path1 path2`); otherwise everything via `git add -A`. Local commit only —
 * pushing is a separate step.
 */
export async function commitProject(
	userId: string,
	projectId: string,
	input: { message: string; paths?: string[] },
): Promise<{ committed: boolean; sha: string | null }> {
	const { path } = await loadProjectAndRepo(userId, projectId)
	const message = input.message.trim()
	if (!message) throw new Error('Commit message must not be empty')

	if (input.paths && input.paths.length > 0) {
		const safePaths = input.paths.map((p) => {
			if (p.includes('..') || p.startsWith('/')) throw new Error(`Unsafe path in commit: ${p}`)
			return p
		})
		const addRes = await runGit(['add', '--', ...safePaths], { repoPath: path })
		if (addRes.code !== 0) {
			throw new Error(`git add failed (exit ${addRes.code}): ${addRes.stderr.trim()}`)
		}
	} else {
		const addRes = await runGit(['add', '-A'], { repoPath: path })
		if (addRes.code !== 0) {
			throw new Error(`git add failed (exit ${addRes.code}): ${addRes.stderr.trim()}`)
		}
	}

	// Server-side git reads no host config, so an imported clone has no identity unless the
	// repository sets one. Fall back to the one local projects are created with.
	const identity = await runGit(['config', '--get', 'user.email'], { repoPath: path })
	const config = identity.code === 0 && identity.stdout.trim() ? [] : ['user.name=AgentStudio', 'user.email=agentstudio@local']
	const commitRes = await runGit(['commit', '-m', message], { repoPath: path, config })
	if (commitRes.code !== 0) {
		// `nothing to commit` is a non-error from the user's POV — surface it cleanly.
		const stderr = (commitRes.stderr + commitRes.stdout).toLowerCase()
		if (stderr.includes('nothing to commit') || stderr.includes('no changes added')) {
			return { committed: false, sha: null }
		}
		throw new Error(`git commit failed (exit ${commitRes.code}): ${commitRes.stderr.trim() || commitRes.stdout.trim()}`)
	}

	const headRes = await runGit(['rev-parse', 'HEAD'], { repoPath: path })
	const sha = headRes.code === 0 ? headRes.stdout.trim() : null
	return { committed: true, sha }
}

/**
 * Re-fetch from origin (when the project has a sidecar `repositories` row pointing at one).
 * Updates `projects.last_pulled_at`. For local-only projects this throws.
 */
export async function pullProject(
	userId: string,
	projectId: string,
): Promise<{ ok: boolean; lastPulledAt: Date; refresh: CloneRefreshOutcome; summary: string }> {
	const { project, repository, path } = await loadProjectAndRepo(userId, projectId)
	if (project.repoKind !== 'imported' || !repository) {
		throw new Error('Pull is only available for imported projects.')
	}

	let token = ''
	let credentialUsername: string | undefined

	if (repository.provider === 'github') {
		const conn = await getActiveGithubConnection(userId)
		if (!conn) throw new Error(GITHUB_RECONNECT_MESSAGE)
		token = conn.accessToken
		credentialUsername = 'x-access-token'
	}

	const refresh = await fetchProjectRemote({
		userId,
		projectId,
		cloneUrl: repository.cloneUrl,
		token,
		credentialUsername,
	})

	const now = new Date()
	await db.update(projects).set({ lastPulledAt: now, updatedAt: now }).where(eq(projects.id, projectId))
	void path // referenced for symmetry; actual fs work happens in fetchProjectRemote
	return { ok: true, lastPulledAt: now, refresh, summary: describeCloneRefresh(refresh) }
}

/**
 * Push a branch to the project's remote. Only GitHub is wired up (mirrors existing
 * source-control push behavior); generic URLs throw with a clear message.
 */
export async function pushProjectBranch(
	userId: string,
	projectId: string,
	input: { branch: string; force?: boolean },
): Promise<PushBranchResult> {
	const { repository, path } = await loadProjectAndRepo(userId, projectId)
	if (!repository) throw new Error('Push is only available for imported projects.')
	if (!SAFE_BRANCH.test(input.branch)) throw new Error(`Invalid branch name: ${input.branch}`)

	if (repository.provider !== 'github') {
		throw new Error('Push is currently only supported for GitHub-backed projects.')
	}

	const conn = await getActiveGithubConnection(userId)
	if (!conn) throw new Error(GITHUB_RECONNECT_MESSAGE)

	return pushBranchToGithub({
		repoPath: path,
		owner: repository.owner,
		repo: repository.name,
		branch: input.branch,
		token: conn.accessToken,
		force: input.force,
	})
}

export type ProjectBranch = {
	name: string
	isCurrent: boolean
	isRemote: boolean
}

/**
 * List local + remote branches via `git for-each-ref`. Local refs come first; remote-tracking
 * branches are flagged with `isRemote=true` so the UI can render them differently (e.g.
 * "Switch to" with a "track remote" hint).
 */
export async function listProjectBranches(userId: string, projectId: string): Promise<ProjectBranch[]> {
	const { path } = await loadProjectAndRepo(userId, projectId)
	const headRes = await runGit(['symbolic-ref', '--short', 'HEAD'], { repoPath: path })
	const current = headRes.code === 0 ? headRes.stdout.trim() : null

	const localRes = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { repoPath: path })
	const remoteRes = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], { repoPath: path })
	const branches: ProjectBranch[] = []
	if (localRes.code === 0) {
		for (const line of localRes.stdout.split(/\r?\n/)) {
			const name = line.trim()
			if (!name) continue
			branches.push({ name, isCurrent: name === current, isRemote: false })
		}
	}
	if (remoteRes.code === 0) {
		for (const line of remoteRes.stdout.split(/\r?\n/)) {
			const name = line.trim()
			if (!name) continue
			if (name === 'origin/HEAD' || name.endsWith('/HEAD')) continue
			branches.push({ name, isCurrent: false, isRemote: true })
		}
	}
	return branches
}

export async function createProjectBranch(
	userId: string,
	projectId: string,
	input: { name: string; from?: string },
): Promise<{ branch: string }> {
	const { path } = await loadProjectAndRepo(userId, projectId)
	if (!SAFE_BRANCH.test(input.name)) throw new Error(`Invalid branch name: ${input.name}`)
	if (input.from && !SAFE_REF.test(input.from)) throw new Error(`Invalid base ref: ${input.from}`)
	const args = ['checkout', '-b', input.name]
	if (input.from) args.push(input.from)
	const res = await runGit(args, { repoPath: path })
	if (res.code !== 0) {
		throw new Error(`git checkout -b failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`)
	}
	return { branch: input.name }
}

export async function switchProjectBranch(
	userId: string,
	projectId: string,
	name: string,
): Promise<{ branch: string }> {
	const { path } = await loadProjectAndRepo(userId, projectId)
	if (!SAFE_BRANCH.test(name)) throw new Error(`Invalid branch name: ${name}`)
	const res = await runGit(['checkout', name], { repoPath: path })
	if (res.code !== 0) {
		throw new Error(`git checkout failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`)
	}
	return { branch: name }
}

export type ProjectDiffFile = {
	path: string
	header: string
	hunks: string
}

/**
 * Return per-file unified diff entries for the working tree against `ref` (default: HEAD).
 * Output is the raw `git diff` text split on `diff --git ` boundaries — the caller renders
 * it. We don't try to parse to structured hunks here; surfacing the raw unified diff keeps
 * the viewer simple and lets the agent feed it back into edit_file tools verbatim.
 */
export async function getProjectDiff(
	userId: string,
	projectId: string,
	opts: { ref?: string; paths?: string[] } = {},
): Promise<{ ref: string; files: ProjectDiffFile[]; raw: string }> {
	const { path } = await loadProjectAndRepo(userId, projectId)
	const ref = assertSafeRevision(opts.ref?.trim() || 'HEAD')
	// `--end-of-options`: whatever `ref` is, git reads it as a revision, never a flag.
	const args = ['diff', '--no-color', '--end-of-options', ref]
	if (opts.paths && opts.paths.length > 0) {
		for (const p of opts.paths) {
			if (p.includes('..') || p.startsWith('/')) throw new Error(`Unsafe path in diff: ${p}`)
		}
		args.push('--', ...opts.paths)
	}
	const res = await runGit(args, { repoPath: path })
	if (res.code !== 0) {
		throw new Error(`git diff failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`)
	}

	const raw = res.stdout
	const files: ProjectDiffFile[] = []
	const segments = raw.split(/^diff --git /m)
	for (let i = 1; i < segments.length; i++) {
		const segment = segments[i]
		const newlineIdx = segment.indexOf('\n')
		const header = `diff --git ${newlineIdx >= 0 ? segment.slice(0, newlineIdx) : segment}`
		const body = newlineIdx >= 0 ? segment.slice(newlineIdx + 1) : ''
		const pathMatch = /a\/(.+?) b\/(.+)/.exec(header)
		const filePath = pathMatch ? pathMatch[2].trim() : 'unknown'
		files.push({ path: filePath, header, hunks: body })
	}
	return { ref, files, raw }
}
