import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runGit, type GitRemoteAccess } from './git-exec.server'
import {
	buildCloneArgs,
	buildFastForwardArgs,
	buildFetchArgs,
	buildHeadBranchArgs,
	buildMirrorPath,
	describeCloneRefresh,
	githubCloneUrl,
	DEFAULT_CREDENTIAL_USERNAME,
	type CloneRefreshOutcome,
} from './repo-mirror'

/**
 * Wave 5 #19 phase 2 (mirror slice) — local-mirror materialization for connected repos.
 *
 * Given an `(owner, repo)` pair the user has connected, ensures a full clone exists at
 * `${mirrorRoot}/<owner>/<repo>` (one clone per repo, shared across runs for the same
 * user). Idempotent: a fresh path triggers `git clone`; a populated path is refreshed —
 * every remote branch fetched into `origin/*`, and the checked-out branch fast-forwarded
 * when that cannot lose anything. Returns a `{path, fresh}` marker so callers can show the
 * operator whether work is happening on a brand-new tree or one with prior agent activity.
 *
 * Git runs through `runGit`, which is hardened against the clone's own config (the agent
 * can write it) and carries the token as a URL-scoped header in the child environment —
 * never argv, never a credential helper. Output is token-redacted before it is returned.
 *
 * No DB writes — that's the caller's responsibility (the agent tool that wraps this
 * helper does the user-owns-this-repo authorization check before invoking).
 */

const REQUEST_TIMEOUT_MS = 120_000

export type MaterializeMirrorInput = {
	mirrorRoot: string
	owner: string
	repo: string
	token: string
	/** Optional default branch hint — `git clone` figures it out anyway, but accepting it
	 * here lets the caller log "(default branch: main)" without an extra round-trip. */
	defaultBranch?: string
	/** Override the GitHub-only URL build. When set, used verbatim as the remote URL.
	 * Required for non-GitHub providers (generic clones). */
	cloneUrl?: string
	/** Username the token authenticates as. Defaults to `x-access-token` (GitHub OAuth).
	 * Irrelevant when `token` is empty, which is an anonymous clone. */
	credentialUsername?: string
}

export type MaterializeMirrorResult = {
	path: string
	fresh: boolean
	branch: string | null
	/** Set when an existing clone was refreshed rather than cloned. */
	refresh?: CloneRefreshOutcome
	/** Plain-English summary of `refresh`, for tool results and toasts. */
	refreshSummary?: string
	stdout: string
	stderr: string
}

async function pathExists(absPath: string): Promise<boolean> {
	try {
		await stat(absPath)
		return true
	} catch {
		return false
	}
}

async function isGitRepo(absPath: string): Promise<boolean> {
	try {
		const gitEntry = await stat(join(absPath, '.git'))
		return gitEntry.isDirectory() || gitEntry.isFile()
	} catch {
		return false
	}
}

function remoteAccess(url: string, token: string, username: string | undefined): GitRemoteAccess {
	return { url, token, username: username || DEFAULT_CREDENTIAL_USERNAME }
}

// Re-exports so existing imports of `./repo-mirror.server` keep working.
export { buildCloneArgs, buildFetchArgs, buildHeadBranchArgs, buildMirrorPath } from './repo-mirror'

/** `git clone` into `targetPath`, whose parent must exist. Throws with redacted output on failure. */
export async function cloneRepository(input: {
	remoteUrl: string
	targetPath: string
	token: string
	credentialUsername?: string
	cwd: string
}): Promise<void> {
	const res = await runGit(buildCloneArgs({ remoteUrl: input.remoteUrl, targetPath: input.targetPath }), {
		cwd: input.cwd,
		remote: remoteAccess(input.remoteUrl, input.token, input.credentialUsername),
		timeoutMs: REQUEST_TIMEOUT_MS,
	})
	if (res.code !== 0) {
		throw new Error(`git clone failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`)
	}
}

export async function detectCheckedOutBranch(repoPath: string): Promise<string | null> {
	const res = await runGit(buildHeadBranchArgs(), { repoPath })
	const branch = res.code === 0 ? res.stdout.trim() : ''
	return branch.length > 0 ? branch : null
}

async function resolveCommit(repoPath: string, ref: string): Promise<string | null> {
	const res = await runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { repoPath })
	const sha = res.code === 0 ? res.stdout.trim() : ''
	return sha.length > 0 ? sha : null
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
	const res = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], { repoPath })
	return res.code === 0
}

/**
 * Bring an existing clone up to date with its remote. Every remote branch lands in
 * `refs/remotes/origin/*` (pruning deleted ones); then the checked-out branch is
 * fast-forwarded to its `origin/` counterpart when it is strictly behind. A branch with
 * local commits, or edits the fast-forward would touch, is left exactly as it was — the
 * outcome says which, so the caller can tell the user instead of claiming success.
 */
export async function refreshClone(input: {
	repoPath: string
	remoteUrl: string
	token: string
	credentialUsername?: string
}): Promise<CloneRefreshOutcome> {
	const fetchRes = await runGit(buildFetchArgs({ remoteUrl: input.remoteUrl }), {
		repoPath: input.repoPath,
		remote: remoteAccess(input.remoteUrl, input.token, input.credentialUsername),
		timeoutMs: REQUEST_TIMEOUT_MS,
	})
	if (fetchRes.code !== 0) {
		throw new Error(`git fetch failed (exit ${fetchRes.code}): ${fetchRes.stderr.trim() || fetchRes.stdout.trim()}`)
	}

	const branch = await detectCheckedOutBranch(input.repoPath)
	if (!branch) return { status: 'skipped', branch: null, reason: 'detached-head' }

	const remoteSha = await resolveCommit(input.repoPath, `refs/remotes/origin/${branch}`)
	if (!remoteSha) return { status: 'skipped', branch, reason: 'no-remote-branch' }
	const localSha = await resolveCommit(input.repoPath, 'HEAD')
	if (localSha === remoteSha) return { status: 'up-to-date', branch }
	// Local is ahead: the remote has nothing we lack.
	if (localSha && (await isAncestor(input.repoPath, remoteSha, localSha))) return { status: 'up-to-date', branch }
	if (localSha && !(await isAncestor(input.repoPath, localSha, remoteSha))) {
		return { status: 'skipped', branch, reason: 'diverged' }
	}

	const mergeRes = await runGit(buildFastForwardArgs(branch), { repoPath: input.repoPath })
	if (mergeRes.code !== 0) return { status: 'skipped', branch, reason: 'local-changes' }
	return { status: 'fast-forwarded', branch, from: localSha ?? '', to: remoteSha }
}

export async function materializeRepoMirror(input: MaterializeMirrorInput): Promise<MaterializeMirrorResult> {
	const targetPath = buildMirrorPath(input.mirrorRoot, input.owner, input.repo)
	const remoteUrl = input.cloneUrl ?? githubCloneUrl(input.owner, input.repo)

	const exists = await pathExists(targetPath)
	const fresh = !exists || !(await isGitRepo(targetPath))

	let refresh: CloneRefreshOutcome | undefined
	if (fresh) {
		// Make sure the parent dir exists. `git clone` creates the leaf.
		await mkdir(dirname(targetPath), { recursive: true })
		await cloneRepository({
			remoteUrl,
			targetPath,
			token: input.token,
			credentialUsername: input.credentialUsername,
			cwd: dirname(targetPath),
		})
	} else {
		refresh = await refreshClone({
			repoPath: targetPath,
			remoteUrl,
			token: input.token,
			credentialUsername: input.credentialUsername,
		})
	}

	const branch = (await detectCheckedOutBranch(targetPath)) ?? input.defaultBranch ?? null

	return {
		path: targetPath,
		fresh,
		branch,
		...(refresh ? { refresh, refreshSummary: describeCloneRefresh(refresh) } : {}),
		stdout: '',
		stderr: '',
	}
}
