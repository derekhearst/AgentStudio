import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
	buildCloneArgs,
	buildFetchArgs,
	buildHeadBranchArgs,
	buildMirrorPath,
	sanitizeRepoSegment,
} from './repo-mirror'

/**
 * Wave 5 #19 phase 2 (mirror slice) — local-mirror materialization for connected repos.
 *
 * Given an `(owner, repo)` pair the user has connected, ensures a full clone exists at
 * `${mirrorRoot}/<owner>/<repo>` (one clone per repo, shared across runs for the same
 * user). Idempotent: a fresh path triggers `git clone`; a populated path triggers
 * `git fetch --prune` so subsequent calls pick up new refs. Returns a `{path, fresh}`
 * marker so callers can show the operator whether work is happening on a brand-new tree
 * or one with prior agent activity.
 *
 * Same credential-helper indirection as `git-push.server.ts`: the OAuth token is sourced
 * from `GIT_TOKEN` env var via `credential.helper=!f() { ...; }; f`, never embedded in
 * argv. Stdout/stderr are token-redacted before they're returned.
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
}

export type MaterializeMirrorResult = {
	path: string
	fresh: boolean
	branch: string | null
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

function redact(text: string, token: string): string {
	if (!token) return text
	return text.split(token).join('***REDACTED***')
}

async function runGitCommand(args: string[], token: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const ac = new AbortController()
		const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
		let stdout = ''
		let stderr = ''
		const proc = spawn('git', args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				GIT_TOKEN: token,
				GIT_TERMINAL_PROMPT: '0',
			},
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
			resolve({ stdout, stderr: `${stderr}\n${(err as Error).message}`, code: -1 })
		})
		proc.on('close', (code) => {
			clearTimeout(timer)
			resolve({ stdout, stderr, code: code ?? -1 })
		})
	})
}

// Re-exports so existing imports of `./repo-mirror.server` keep working.
export { buildCloneArgs, buildFetchArgs, buildHeadBranchArgs, buildMirrorPath } from './repo-mirror'

export async function materializeRepoMirror(input: MaterializeMirrorInput): Promise<MaterializeMirrorResult> {
	const targetPath = buildMirrorPath(input.mirrorRoot, input.owner, input.repo)
	const remoteUrl = `https://github.com/${sanitizeRepoSegment(input.owner, 'owner')}/${sanitizeRepoSegment(input.repo, 'repo')}.git`

	const exists = await pathExists(targetPath)
	const fresh = !exists || !(await isGitRepo(targetPath))

	if (fresh) {
		// Make sure the parent dir exists. `git clone` creates the leaf.
		await mkdir(dirname(targetPath), { recursive: true })

		const cloneRes = await runGitCommand(buildCloneArgs({ remoteUrl, targetPath }), input.token)
		if (cloneRes.code !== 0) {
			throw new Error(
				`git clone failed (exit ${cloneRes.code}): ${redact(cloneRes.stderr.trim() || cloneRes.stdout.trim(), input.token)}`,
			)
		}
	} else {
		const fetchRes = await runGitCommand(buildFetchArgs({ repoPath: targetPath, remoteUrl }), input.token)
		if (fetchRes.code !== 0) {
			throw new Error(
				`git fetch failed (exit ${fetchRes.code}): ${redact(fetchRes.stderr.trim() || fetchRes.stdout.trim(), input.token)}`,
			)
		}
	}

	let branch: string | null = input.defaultBranch ?? null
	const headRes = await runGitCommand(buildHeadBranchArgs(targetPath), input.token)
	if (headRes.code === 0) {
		const detected = headRes.stdout.trim()
		if (detected.length > 0) branch = detected
	}

	return {
		path: targetPath,
		fresh,
		branch,
		stdout: '',
		stderr: '',
	}
}
