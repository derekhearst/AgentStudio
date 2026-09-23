import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
	buildHardenedGitEnv,
	filterDriverOverrides,
	hardenedConfigArgs,
	needsTreeProtection,
	operatorProxyFor,
	pinsWorkTree,
	redactGitSecret,
	remoteAccessConfig,
	subcommandHardeningFlags,
	type GitConfigEntry,
	type GitRemoteAccess,
} from './git-exec'

/**
 * The one place the server spawns git. See `git-exec.ts` for what the hardening is and
 * why; this file applies it. Every server-side git call — status for the Repo tab, the
 * agent's git tools, clone, fetch, push, worktree management — goes through `runGit`.
 */

export type { GitRemoteAccess }

export type GitResult = { stdout: string; stderr: string; code: number }

export type RunGitOptions = {
	/** Repository to run in (`git -C <repoPath>`). */
	repoPath?: string
	/** Working directory for commands with no repository yet (`clone`, `init`). */
	cwd?: string
	/** The remote this call talks to, with its credentials when it has any. */
	remote?: GitRemoteAccess
	/** Extra `key=value` config for this call. Applied before the hardening, so it cannot undo it. */
	config?: readonly string[]
	timeoutMs?: number
	/** Output cap. A command that prints more is killed and reported as failed. */
	maxOutputBytes?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024

/** Walk up from `start` to the directory that holds `.git` — the real top of its work tree. */
async function findWorkTreeRoot(start: string): Promise<string | null> {
	let dir = resolve(start)
	for (;;) {
		try {
			await stat(join(dir, '.git'))
			return dir
		} catch {
			const parent = dirname(dir)
			if (parent === dir) return null
			dir = parent
		}
	}
}

function spawnGit(
	args: string[],
	env: Record<string, string>,
	cwd: string | undefined,
	timeoutMs: number,
	maxOutputBytes: number,
): Promise<GitResult> {
	return new Promise((resolveRun) => {
		const ac = new AbortController()
		const timer = setTimeout(() => ac.abort(), timeoutMs)
		let stdout = ''
		let stderr = ''
		let bytes = 0
		let overflowed = false
		const proc = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], signal: ac.signal })
		const collect = (chunk: Buffer, into: 'stdout' | 'stderr') => {
			if (overflowed) return
			bytes += chunk.byteLength
			if (bytes > maxOutputBytes) {
				overflowed = true
				ac.abort()
				return
			}
			if (into === 'stdout') stdout += chunk.toString('utf8')
			else stderr += chunk.toString('utf8')
		}
		proc.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'))
		proc.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'))
		proc.on('error', (err) => {
			clearTimeout(timer)
			const reason = overflowed
				? `git output exceeded ${maxOutputBytes} bytes`
				: ac.signal.aborted
					? `git timed out after ${timeoutMs}ms`
					: (err as Error).message
			resolveRun({ stdout, stderr: `${stderr}\n${reason}`.trim(), code: -1 })
		})
		proc.on('close', (code) => {
			clearTimeout(timer)
			resolveRun({ stdout, stderr, code: code ?? -1 })
		})
	})
}

/**
 * Names of the filter drivers this repository configures. Reading config runs nothing, so
 * this is safe to do before we know which drivers to switch off.
 */
async function listFilterDriverNames(repoPath: string, env: Record<string, string>): Promise<string[]> {
	const res = await spawnGit(
		['--no-pager', ...hardenedConfigArgs(), '-C', repoPath, 'config', '-z', '--name-only', '--get-regexp', '^filter\\.'],
		env,
		undefined,
		30_000,
		1024 * 1024,
	)
	// Exit 1 means "no such keys" — the common case.
	if (res.code !== 0) return []
	return res.stdout.split('\0').filter((name) => name.length > 0)
}

/**
 * Run `git <args>` hardened. `args[0]` is the subcommand; global options come from
 * `options`. Output is returned as text with the remote's token redacted, never thrown:
 * callers read `code`.
 */
export async function runGit(args: readonly string[], options: RunGitOptions = {}): Promise<GitResult> {
	const [subcommand, ...rest] = args
	if (!subcommand || subcommand.startsWith('-')) {
		throw new Error(`runGit expects a subcommand first, got ${JSON.stringify(subcommand)}`)
	}

	const configEntries: GitConfigEntry[] = []
	const globalArgs = ['--no-pager', ...hardenedConfigArgs(options.config)]

	if (options.repoPath) {
		globalArgs.push('-C', options.repoPath)
		if (needsTreeProtection(subcommand)) {
			const scanEnv = buildHardenedGitEnv(process.env)
			configEntries.push(...filterDriverOverrides(await listFilterDriverNames(options.repoPath, scanEnv)))
			if (pinsWorkTree(subcommand)) {
				const root = await findWorkTreeRoot(options.repoPath)
				if (root) globalArgs.push(`--work-tree=${root}`)
			}
		}
	}

	if (options.remote) {
		configEntries.push(...remoteAccessConfig(options.remote, operatorProxyFor(options.remote.url, process.env)))
	}

	const env = buildHardenedGitEnv(process.env, { configEntries, remoteUrl: options.remote?.url })
	const argv = [...globalArgs, subcommand, ...subcommandHardeningFlags(subcommand, rest), ...rest]
	const result = await spawnGit(
		argv,
		env,
		options.cwd,
		options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
	)
	return {
		stdout: redactGitSecret(result.stdout, options.remote),
		stderr: redactGitSecret(result.stderr, options.remote),
		code: result.code,
	}
}

/**
 * Adapter for argv-shaped callers (`GitRunner`, the worktree builders): a leading
 * `-C <path>` becomes `repoPath` and leading `-c <pair>` becomes extra config. Any other
 * leading option is refused rather than passed through unhardened.
 */
export function runGitArgv(argv: readonly string[], options: Omit<RunGitOptions, 'repoPath' | 'config'> = {}): Promise<GitResult> {
	let i = 0
	let repoPath: string | undefined
	const config: string[] = []
	while (i < argv.length && argv[i].startsWith('-')) {
		const flag = argv[i]
		const value = argv[i + 1]
		if (value === undefined) break
		if (flag === '-C') repoPath = value
		else if (flag === '-c') config.push(value)
		else return Promise.reject(new Error(`runGitArgv: unsupported global option ${flag}`))
		i += 2
	}
	return runGit(argv.slice(i), { ...options, repoPath, config })
}
