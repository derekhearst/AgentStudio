import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { projects, type ProjectRow } from './projects.schema'
import { repositories, type RepositoryRow } from '$lib/source-control/source-control.schema'
import { defaultGitRunner } from '$lib/workspace/worktree.server'
import {
	gitStatusAt,
	listRecentCommits,
	prepareCommitDraft,
	type CommitDraft,
	type GitCommitSummary,
} from '$lib/source-control/git-local.server'
import { pushBranchToGithub, type PushBranchResult } from '$lib/source-control/git-push.server'
import { getProjectPath, fetchProjectRemote } from './project-fs.server'
import { getActiveAzureConnection, getActiveGithubConnection } from '$lib/source-control/source-control.server'

/**
 * Project-aware wrappers around the existing git primitives. The agent + UI layer should
 * route through these so they don't need to know about the underlying source-control
 * helpers — pass a `(userId, projectId)` and we resolve the on-disk path, the sidecar
 * `repositories` row (if any), and the OAuth token to authenticate remote operations.
 *
 * No DB mutations live here except `pullProject`'s `last_pulled_at` stamp; everything else
 * is a thin read on the working copy.
 */

const SAFE_BRANCH = /^[a-zA-Z0-9_/-]+$/
const SAFE_REF = /^[a-zA-Z0-9_/-]+$/
const REQUEST_TIMEOUT_MS = 60_000

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

async function runGit(args: string[], cwd: string, env: Record<string, string> = {}) {
	return new Promise<{ stdout: string; stderr: string; code: number }>((resolveRun) => {
		const ac = new AbortController()
		const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
		let stdout = ''
		let stderr = ''
		const proc = spawn('git', args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
			signal: ac.signal,
		})
		proc.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8')
		})
		proc.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8')
		})
		proc.on('error', (err) => {
			clearTimeout(timer)
			resolveRun({ stdout, stderr: `${stderr}\n${(err as Error).message}`, code: -1 })
		})
		proc.on('close', (code) => {
			clearTimeout(timer)
			resolveRun({ stdout, stderr, code: code ?? -1 })
		})
	})
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
		const addRes = await runGit(['add', '--', ...safePaths], path)
		if (addRes.code !== 0) {
			throw new Error(`git add failed (exit ${addRes.code}): ${addRes.stderr.trim()}`)
		}
	} else {
		const addRes = await runGit(['add', '-A'], path)
		if (addRes.code !== 0) {
			throw new Error(`git add failed (exit ${addRes.code}): ${addRes.stderr.trim()}`)
		}
	}

	const commitRes = await runGit(['commit', '-m', message], path)
	if (commitRes.code !== 0) {
		// `nothing to commit` is a non-error from the user's POV — surface it cleanly.
		const stderr = (commitRes.stderr + commitRes.stdout).toLowerCase()
		if (stderr.includes('nothing to commit') || stderr.includes('no changes added')) {
			return { committed: false, sha: null }
		}
		throw new Error(`git commit failed (exit ${commitRes.code}): ${commitRes.stderr.trim() || commitRes.stdout.trim()}`)
	}

	const headRes = await runGit(['rev-parse', 'HEAD'], path)
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
): Promise<{ ok: boolean; lastPulledAt: Date }> {
	const { project, repository, path } = await loadProjectAndRepo(userId, projectId)
	if (project.repoKind !== 'imported' || !repository) {
		throw new Error('Pull is only available for imported projects.')
	}

	let token = ''
	let credentialUsername: string | undefined

	if (repository.provider === 'github') {
		const conn = await getActiveGithubConnection(userId)
		if (!conn) throw new Error('GitHub connection unavailable. Reconnect at /projects.')
		token = conn.accessToken
		credentialUsername = 'x-access-token'
	} else if (repository.provider === 'azure_devops') {
		const azure = (repository.metadata as { azure?: { org?: string } }).azure
		if (azure?.org) {
			const conn = await getActiveAzureConnection(userId, azure.org)
			if (conn) {
				token = conn.accessToken
				credentialUsername = 'oauth2'
			}
		}
	}

	await fetchProjectRemote({
		userId,
		projectId,
		cloneUrl: repository.cloneUrl,
		token,
		credentialUsername,
	})

	const now = new Date()
	await db.update(projects).set({ lastPulledAt: now, updatedAt: now }).where(eq(projects.id, projectId))
	void path // referenced for symmetry; actual fs work happens in fetchProjectRemote
	return { ok: true, lastPulledAt: now }
}

/**
 * Push a branch to the project's remote. Currently only GitHub is wired up (mirrors
 * existing source-control push behavior). Azure DevOps + generic URLs throw with a
 * clear message.
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
	if (!conn) throw new Error('GitHub connection unavailable. Reconnect at /projects.')

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
	const headRes = await runGit(['symbolic-ref', '--short', 'HEAD'], path)
	const current = headRes.code === 0 ? headRes.stdout.trim() : null

	const localRes = await runGit(
		['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
		path,
	)
	const remoteRes = await runGit(
		['for-each-ref', '--format=%(refname:short)', 'refs/remotes'],
		path,
	)
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
	const res = await runGit(args, path)
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
	const res = await runGit(['checkout', name], path)
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
	const ref = opts.ref?.trim() || 'HEAD'
	if (!SAFE_REF.test(ref)) throw new Error(`Invalid ref: ${ref}`)
	const args = ['diff', '--no-color', ref]
	if (opts.paths && opts.paths.length > 0) {
		for (const p of opts.paths) {
			if (p.includes('..') || p.startsWith('/')) throw new Error(`Unsafe path in diff: ${p}`)
		}
		args.push('--', ...opts.paths)
	}
	const res = await runGit(args, path)
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

void defaultGitRunner // satisfies unused-import lint when tests stub runs
