import { join } from 'node:path'

/**
 * Wave 5 #19 phase 2 — pure argv builders + path-bounding helpers for the repo mirror.
 *
 * Lives in a non-server file so unit tests can import it without running into the
 * Playwright/Vite cache quirks that surface for `.server.ts` modules. The actual
 * filesystem-touching `materializeRepoMirror` lives in `repo-mirror.server.ts` and
 * re-exports these so existing call sites don't change.
 */

// First char rejects leading dot so a malicious repo name like `.git` can't collide with
// the real `.git` metadata dir; subsequent chars allow dots so `repo.name` round-trips.
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/
// Default username matches GitHub OAuth's `x-access-token` convention. Azure DevOps and
// generic-PAT callers override via `credentialUsername`. The literal `$GIT_TOKEN` is
// expanded by the bash function shipped with git-credential-helper at runtime.
const DEFAULT_CREDENTIAL_USERNAME = 'x-access-token'
const SAFE_USERNAME = /^[A-Za-z0-9._-]{0,64}$/

function buildCredentialHelperArg(credentialUsername: string): string {
	if (!SAFE_USERNAME.test(credentialUsername)) {
		throw new Error(`Invalid credential username: ${credentialUsername}`)
	}
	return `credential.helper=!f() { echo "username=${credentialUsername}"; echo "password=$GIT_TOKEN"; }; f`
}

export function sanitizeRepoSegment(segment: string, kind: string): string {
	if (!SAFE_SEGMENT.test(segment)) {
		throw new Error(`Invalid ${kind} segment for repo mirror: ${segment}`)
	}
	return segment
}

export function buildCloneArgs(input: {
	remoteUrl: string
	targetPath: string
	credentialUsername?: string
}): string[] {
	return [
		'-c',
		buildCredentialHelperArg(input.credentialUsername ?? DEFAULT_CREDENTIAL_USERNAME),
		'clone',
		'--no-tags',
		input.remoteUrl,
		input.targetPath,
	]
}

export function buildFetchArgs(input: {
	repoPath: string
	remoteUrl: string
	credentialUsername?: string
}): string[] {
	return [
		'-c',
		buildCredentialHelperArg(input.credentialUsername ?? DEFAULT_CREDENTIAL_USERNAME),
		'-C',
		input.repoPath,
		'fetch',
		'--prune',
		input.remoteUrl,
	]
}

export function buildHeadBranchArgs(repoPath: string): string[] {
	return ['-C', repoPath, 'symbolic-ref', '--short', 'HEAD']
}

export function buildMirrorPath(mirrorRoot: string, owner: string, repo: string): string {
	const safeOwner = sanitizeRepoSegment(owner, 'owner')
	const safeRepo = sanitizeRepoSegment(repo, 'repo')
	return join(mirrorRoot, safeOwner, safeRepo)
}

export { buildCredentialHelperArg, DEFAULT_CREDENTIAL_USERNAME }
