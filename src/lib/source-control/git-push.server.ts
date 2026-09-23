import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runGit } from './git-exec.server'
import { assertSafeBranchName, isSafeBranchName } from './git-exec'
import { githubCloneUrl } from './repo-mirror'
import { parseCloneUrl } from './parse-clone-url'

/**
 * Wave 5 #19 phase 3 finish — `git push` with a GitHub OAuth token.
 *
 * Safety choices in this module:
 *
 *   1. The token never reaches argv, a file, or a credential helper. `runGit` hands it to
 *      git as an `Authorization` header scoped to the exact GitHub URL, through
 *      `GIT_CONFIG_COUNT` in the child environment, with the repository's hooks, helpers
 *      and program-running config switched off (see `git-exec.ts`).
 *
 *   2. We push to a fully-qualified GitHub HTTPS URL, never to whatever the local `origin`
 *      remote happens to be. If the repository's config rewrites or reroutes that URL, the
 *      rewritten destination does not match the header's scope and gets no token.
 *
 * `--force-with-lease` is opt-in via `force: true` and is the safer cousin of `--force`:
 * the push is rejected if the remote branch has moved since AgentStudio last saw it. We
 * never use plain `--force` — agents should never overwrite work without seeing it first.
 *
 * "Last saw it" needs a record, and a push to a URL has none: git's bare
 * `--force-with-lease` looks for a remote-tracking ref, finds nothing for an anonymous URL,
 * and rejects every existing branch as "stale info". So the lease is spelled out, from one
 * of two records:
 *
 *   - `refs/remotes/origin/<branch>` when the repository's `origin` is the push target.
 *     Clone, "Pull latest" and every successful push below keep it current.
 *   - Otherwise `refs/agentstudio/pushed/<target>/<branch>` (`pushRecordRef`): what
 *     AgentStudio itself last pushed there. Written after every successful push, whatever
 *     the target — a local project with no `origin`, or a push to a repo that is not it.
 *
 * With no record the expectation is "the branch does not exist yet".
 *
 * Returns the structured push result (stderr is the source of truth for git's pretty output)
 * so the caller can show the operator exactly what happened.
 */

const REQUEST_TIMEOUT_MS = 60_000

export type PushBranchInput = {
	repoPath: string
	owner: string
	repo: string
	/** Branch name to push (no `refs/heads/` prefix). Pushed to the same name on the remote. */
	branch: string
	token: string
	/** When true, uses `--force-with-lease`. We never expose plain `--force`. */
	force?: boolean
}

export type PushBranchResult = {
	success: boolean
	branch: string
	remote: string
	stdout: string
	stderr: string
	exitCode: number
}

async function pathIsGitRepository(absPath: string): Promise<boolean> {
	try {
		const gitEntry = await stat(join(absPath, '.git'))
		return gitEntry.isDirectory() || gitEntry.isFile()
	} catch {
		return false
	}
}

/**
 * The push argv. `leaseExpected` is only read when `force` is set: a sha means "only if
 * the remote branch is still at this commit", an empty string means "only if it does not
 * exist".
 */
function buildPushArgs(input: {
	remote: string
	branch: string
	force?: boolean
	leaseExpected?: string
}): string[] {
	const branch = assertSafeBranchName(input.branch)
	const args = ['push']
	if (input.force) args.push(`--force-with-lease=refs/heads/${branch}:${input.leaseExpected ?? ''}`)
	args.push(input.remote, `refs/heads/${branch}:refs/heads/${branch}`)
	return args
}

/** Same repository? GitHub URLs compare by owner/repo, anything else by normalized URL. */
function sameRemote(a: string, b: string): boolean {
	try {
		const pa = parseCloneUrl(a)
		const pb = parseCloneUrl(b)
		if (pa.provider === 'github' && pb.provider === 'github') {
			return pa.owner.toLowerCase() === pb.owner.toLowerCase() && pa.repo.toLowerCase() === pb.repo.toLowerCase()
		}
	} catch {
		// Not a URL parseCloneUrl knows; fall through to the plain comparison.
	}
	const normalize = (url: string) => url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')
	return normalize(a) === normalize(b)
}

/**
 * The tracking ref recording what AgentStudio last saw of `branch` on `remote` — the
 * repository's `refs/remotes/origin/<branch>`, but only when `origin` is that remote.
 */
async function trackingRefFor(repoPath: string, remote: string, branch: string): Promise<string | null> {
	const res = await runGit(['config', '--get', 'remote.origin.url'], { repoPath })
	if (res.code !== 0 || !sameRemote(res.stdout.trim(), remote)) return null
	return `refs/remotes/origin/${branch}`
}

/** Refs under here are AgentStudio's own bookkeeping; git and the user's tools ignore them. */
const PUSH_RECORD_NAMESPACE = 'refs/agentstudio/pushed'

/**
 * Where the commit AgentStudio last pushed to `branch` at `remote` is recorded. Keyed by
 * the target: `github.com/<owner>/<repo>` (lower-cased, as GitHub compares them) for a
 * GitHub URL, a hash of the normalised URL for anything else.
 */
export function pushRecordRef(remote: string, branch: string): string {
	assertSafeBranchName(branch)
	let key: string | null = null
	try {
		const parsed = parseCloneUrl(remote)
		if (parsed.provider === 'github') {
			const candidate = `github.com/${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}`
			if (isSafeBranchName(candidate)) key = candidate
		}
	} catch {
		// Not a URL parseCloneUrl knows; hashed below.
	}
	if (!key) {
		const normalized = remote.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')
		key = `url/${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`
	}
	return `${PUSH_RECORD_NAMESPACE}/${key}/${branch}`
}

async function resolveCommit(repoPath: string, ref: string): Promise<string | null> {
	const res = await runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { repoPath })
	const sha = res.code === 0 ? res.stdout.trim() : ''
	return sha.length > 0 ? sha : null
}

/**
 * Push `branch` to the same branch name at `remote`. The GitHub wrapper below is what the
 * app calls; this takes any URL so the lease logic can be exercised against a local server.
 */
export async function pushBranch(input: {
	repoPath: string
	remote: string
	branch: string
	token: string
	username?: string
	force?: boolean
}): Promise<PushBranchResult> {
	if (!(await pathIsGitRepository(input.repoPath))) {
		throw new Error(`Path is not a git repository: ${input.repoPath}`)
	}
	assertSafeBranchName(input.branch)

	const trackingRef = await trackingRefFor(input.repoPath, input.remote, input.branch)
	const recordRef = pushRecordRef(input.remote, input.branch)
	const leaseRef = trackingRef ?? recordRef
	const leaseExpected = input.force ? ((await resolveCommit(input.repoPath, leaseRef)) ?? '') : ''
	const pushedSha = await resolveCommit(input.repoPath, `refs/heads/${input.branch}`)
	const args = buildPushArgs({ remote: input.remote, branch: input.branch, force: input.force, leaseExpected })

	const res = await runGit(args, {
		repoPath: input.repoPath,
		remote: { url: input.remote, username: input.username ?? 'x-access-token', token: input.token },
		timeoutMs: REQUEST_TIMEOUT_MS,
	})

	let stderr = res.stderr
	if (res.code === 0) {
		// Record what the remote branch now is, the way a push to a named remote would, so the
		// next force-with-lease has an accurate expectation — whichever record it will read.
		if (pushedSha) {
			await runGit(['update-ref', recordRef, pushedSha], { repoPath: input.repoPath })
			if (trackingRef) await runGit(['update-ref', trackingRef, pushedSha], { repoPath: input.repoPath })
		}
	} else if (input.force && /stale info/.test(stderr)) {
		stderr += trackingRef
			? '\nhint: the remote branch has commits AgentStudio has not fetched. Pull latest, check what changed, then push again.'
			: '\nhint: the remote branch is not where AgentStudio last pushed it — someone else pushed, or AgentStudio never ' +
				'pushed this branch there. Check what is on the remote first; a force-push will not overwrite work AgentStudio has not seen.'
	}

	return {
		success: res.code === 0,
		branch: input.branch,
		remote: input.remote,
		stdout: res.stdout,
		stderr,
		exitCode: res.code,
	}
}

export async function pushBranchToGithub(input: PushBranchInput): Promise<PushBranchResult> {
	return pushBranch({
		repoPath: input.repoPath,
		// Validates owner and repo as path segments before anything runs.
		remote: githubCloneUrl(input.owner, input.repo),
		branch: input.branch,
		token: input.token,
		username: 'x-access-token',
		force: input.force,
	})
}

export { buildPushArgs }
