import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Wave 5 #19 phase 3 finish — `git push` with a GitHub OAuth token.
 *
 * Two safety choices in this module:
 *
 *   1. Token is passed via the `GIT_TOKEN` env var, not argv. The git child reads it through
 *      a one-line credential helper that echoes `username=x-access-token` + `password=$GIT_TOKEN`.
 *      The argv (visible via `ps`) carries the helper string but not the token itself; the
 *      env var is scoped to this single git invocation via `spawn`'s `env` option.
 *
 *   2. We push to a fully-qualified GitHub HTTPS URL, never to whatever the local `origin`
 *      remote happens to be. Even if an attacker mutated `.git/config` to point origin at a
 *      different host, this push always goes to the GitHub repo the agent + operator agreed
 *      on. As a side effect, the local `origin` remote is left untouched.
 *
 * `--force-with-lease` is opt-in via `force: true` and is the safer cousin of `--force`:
 * the push is rejected if the remote ref has moved since the agent last fetched. We never
 * use plain `--force` — agents should never overwrite work without seeing it first.
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

function buildPushArgs(input: PushBranchInput): { args: string[]; remote: string } {
	const remote = `https://github.com/${input.owner}/${input.repo}.git`
	const args = [
		// Helper sourced via shell: prefix `!` makes git treat the value as a shell command.
		// The helper echoes static credentials drawn from $GIT_TOKEN; argv carries the helper
		// string only, never the token.
		'-c',
		'credential.helper=!f() { echo "username=x-access-token"; echo "password=$GIT_TOKEN"; }; f',
		'-C',
		input.repoPath,
		'push',
		remote,
		`refs/heads/${input.branch}:refs/heads/${input.branch}`,
	]
	if (input.force) args.push('--force-with-lease')
	return { args, remote }
}

function redact(text: string, token: string): string {
	if (!token) return text
	return text.split(token).join('***REDACTED***')
}

export async function pushBranchToGithub(input: PushBranchInput): Promise<PushBranchResult> {
	if (!(await pathIsGitRepository(input.repoPath))) {
		throw new Error(`Path is not a git repository: ${input.repoPath}`)
	}

	const { args, remote } = buildPushArgs(input)

	return new Promise<PushBranchResult>((resolve) => {
		const ac = new AbortController()
		const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
		let stdout = ''
		let stderr = ''
		const proc = spawn('git', args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				GIT_TOKEN: input.token,
				// Belt-and-suspenders: even if credential lookup fails, refuse to prompt
				// interactively (we'd hang the worker forever otherwise).
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
			resolve({
				success: false,
				branch: input.branch,
				remote,
				stdout: redact(stdout, input.token),
				stderr: redact(`${stderr}\n${(err as Error).message}`, input.token),
				exitCode: -1,
			})
		})
		proc.on('close', (code) => {
			clearTimeout(timer)
			resolve({
				success: code === 0,
				branch: input.branch,
				remote,
				stdout: redact(stdout, input.token),
				stderr: redact(stderr, input.token),
				exitCode: code ?? -1,
			})
		})
	})
}

export { buildPushArgs }
