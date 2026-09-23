import { join } from 'node:path'

/**
 * Wave 5 #19 phase 2 — pure argv builders + path-bounding helpers for the repo mirror.
 *
 * Lives in a non-server file so unit tests can import it without running into the
 * Playwright/Vite cache quirks that surface for `.server.ts` modules. The actual
 * filesystem-touching `materializeRepoMirror` lives in `repo-mirror.server.ts` and
 * re-exports these so existing call sites don't change.
 *
 * The builders return subcommand argv only. Global options — the repository, the hardening
 * and the token — are added by `runGit` in `git-exec.server.ts`, which is the only thing
 * that runs them. None of them takes a token, so none can put one in argv.
 */

// First char rejects leading dot so a malicious repo name like `.git` can't collide with
// the real `.git` metadata dir; subsequent chars allow dots so `repo.name` round-trips.
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/
// Default username matches GitHub OAuth's `x-access-token` convention. Generic callers
// pass an empty username and no token, which is an anonymous clone.
const DEFAULT_CREDENTIAL_USERNAME = 'x-access-token'

/**
 * Where a refresh writes the remote's branches. The same place `git clone` sets `origin` up
 * to track, so `origin/main` in a clone means "main as of the last clone or refresh".
 */
export const REMOTE_TRACKING_REFSPEC = '+refs/heads/*:refs/remotes/origin/*'

export function sanitizeRepoSegment(segment: string, kind: string): string {
	if (!SAFE_SEGMENT.test(segment)) {
		throw new Error(`Invalid ${kind} segment for repo mirror: ${segment}`)
	}
	return segment
}

export function githubCloneUrl(owner: string, repo: string): string {
	return `https://github.com/${sanitizeRepoSegment(owner, 'owner')}/${sanitizeRepoSegment(repo, 'repo')}.git`
}

export function buildCloneArgs(input: { remoteUrl: string; targetPath: string }): string[] {
	return ['clone', '--no-tags', '--', input.remoteUrl, input.targetPath]
}

/**
 * Fetch every branch of `remoteUrl` into `refs/remotes/origin/*`, pruning branches the
 * remote deleted. The refspec is the point: fetching a bare URL with none only writes
 * FETCH_HEAD, which left every clone frozen at the commit it was first cloned at.
 */
export function buildFetchArgs(input: { remoteUrl: string }): string[] {
	return ['fetch', '--prune', '--no-tags', input.remoteUrl, REMOTE_TRACKING_REFSPEC]
}

export function buildHeadBranchArgs(): string[] {
	return ['symbolic-ref', '--quiet', '--short', 'HEAD']
}

/** Fast-forward the checked-out branch to its fetched counterpart, and never anything else. */
export function buildFastForwardArgs(branch: string): string[] {
	return ['merge', '--ff-only', '--no-edit', `refs/remotes/origin/${branch}`]
}

export function buildMirrorPath(mirrorRoot: string, owner: string, repo: string): string {
	const safeOwner = sanitizeRepoSegment(owner, 'owner')
	const safeRepo = sanitizeRepoSegment(repo, 'repo')
	return join(mirrorRoot, safeOwner, safeRepo)
}

/**
 * What a refresh did to the checked-out branch. The remote-tracking refs are always
 * updated; the working tree only moves when that cannot lose anything.
 */
export type CloneRefreshOutcome =
	| { status: 'fast-forwarded'; branch: string; from: string; to: string }
	| { status: 'up-to-date'; branch: string }
	| { status: 'skipped'; branch: string | null; reason: 'detached-head' | 'no-remote-branch' | 'local-changes' | 'diverged' }

export function describeCloneRefresh(outcome: CloneRefreshOutcome): string {
	switch (outcome.status) {
		case 'fast-forwarded':
			return `Fast-forwarded ${outcome.branch} ${outcome.from.slice(0, 7)}..${outcome.to.slice(0, 7)}.`
		case 'up-to-date':
			return `${outcome.branch} is up to date.`
		case 'skipped':
			switch (outcome.reason) {
				case 'detached-head':
					return 'Fetched the remote branches; HEAD is detached, so nothing was checked out.'
				case 'no-remote-branch':
					return `Fetched the remote branches; ${outcome.branch} has no counterpart on the remote, so it was left alone.`
				case 'local-changes':
					return `Fetched the remote branches; ${outcome.branch} has uncommitted changes, so it was not fast-forwarded.`
				case 'diverged':
					return `Fetched the remote branches; ${outcome.branch} has commits the remote does not, so it was not fast-forwarded.`
			}
	}
}

export { DEFAULT_CREDENTIAL_USERNAME }
