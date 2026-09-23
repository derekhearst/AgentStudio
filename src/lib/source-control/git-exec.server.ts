import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
	buildHardenedGitEnv,
	filterDriverNames,
	gitlinkPathFromStageRecord,
	GIT_SCAN_LIMITS,
	GitRefusedError,
	hardenedConfigArgs,
	needsTreeProtection,
	operatorProxyFor,
	overridesForFilterDrivers,
	pinsWorkTree,
	redactGitSecret,
	remoteAccessConfig,
	remoteRedirectKeys,
	scanSectionsFor,
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
export { GitRefusedError }

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
/** One scan record (a config name, an index path) longer than this is not a real one. */
const MAX_SCAN_RECORD_BYTES = 64 * 1024

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

/** Walk up from `start` to the directory that holds `.git` — the real top of its work tree. */
async function findWorkTreeRoot(start: string): Promise<string | null> {
	let dir = resolve(start)
	for (;;) {
		if (await exists(join(dir, '.git'))) return dir
		const parent = dirname(dir)
		if (parent === dir) return null
		dir = parent
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

// ─────────── Pre-run scans ───────────
//
// Read-only git calls (`config`, `ls-files`, `rev-parse`) that find the names the real call
// has to neutralise. They run with the static hardening, so they run nothing themselves.
// Each one fails closed: anything but a clean answer throws `GitRefusedError`.

/** Where a scan runs: the global options that select the repository, and a name for messages. */
type ScanTarget = { args: string[]; label: string }

/**
 * Run a scan and hand stdout to `onRecord` one NUL-terminated record at a time, keeping
 * none of it — an index with a million entries costs no memory. `onRecord` throws to stop
 * the scan; that, a timeout or a failed spawn come back as `code: -1` with the reason.
 */
function scanGit(
	args: string[],
	env: Record<string, string>,
	onRecord: (record: string) => void,
): Promise<{ code: number; stderr: string }> {
	return new Promise((resolveScan) => {
		const ac = new AbortController()
		const timer = setTimeout(() => ac.abort(), GIT_SCAN_LIMITS.timeoutMs)
		let pending: Buffer = Buffer.alloc(0)
		let stderr = ''
		let failure: string | null = null
		const fail = (reason: string) => {
			if (failure) return
			failure = reason
			ac.abort()
		}
		const proc = spawn('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'], signal: ac.signal })
		proc.stdout.on('data', (chunk: Buffer) => {
			if (failure) return
			pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
			let start = 0
			for (let nul = pending.indexOf(0, start); nul !== -1; nul = pending.indexOf(0, start)) {
				try {
					onRecord(pending.toString('utf8', start, nul))
				} catch (err) {
					fail((err as Error).message)
					return
				}
				start = nul + 1
			}
			pending = pending.subarray(start)
			if (pending.length > MAX_SCAN_RECORD_BYTES) fail(`a record longer than ${MAX_SCAN_RECORD_BYTES} bytes`)
		})
		proc.stderr.on('data', (chunk: Buffer) => {
			if (stderr.length < 8 * 1024) stderr += chunk.toString('utf8')
		})
		const finish = (code: number, reason?: string) => {
			clearTimeout(timer)
			resolveScan({ code: failure ? -1 : code, stderr: failure ?? reason ?? stderr })
		}
		proc.on('error', (err) =>
			finish(-1, ac.signal.aborted ? `timed out after ${GIT_SCAN_LIMITS.timeoutMs}ms` : (err as Error).message),
		)
		proc.on('close', (code) => finish(code ?? -1))
	})
}

function refuse(target: ScanTarget, what: string, detail: string): never {
	throw new GitRefusedError(
		`Refusing to run git in ${target.label}: could not ${what} (${detail.trim() || 'no detail'}). ` +
			'Nothing was run. Check the repository’s .git/config.',
	)
}

/**
 * Names of the config entries in `sections` this repository sets (`git config
 * --name-only`). Exit 1 is git's "no such keys"; exit 0 is a list. Anything else — a config
 * git cannot parse, more entries than the limit, a timeout — refuses: an incomplete list
 * would leave a driver running.
 */
async function readConfigNames(target: ScanTarget, sections: string[], env: Record<string, string>): Promise<string[]> {
	const names: string[] = []
	const pattern = `^(${sections.join('|')})\\.`
	const res = await scanGit([...target.args, 'config', '-z', '--name-only', '--get-regexp', pattern], env, (name) => {
		if (names.length >= GIT_SCAN_LIMITS.configEntries) {
			throw new Error(`more than ${GIT_SCAN_LIMITS.configEntries} ${sections.join('/')} entries`)
		}
		if (name.length > 0) names.push(name)
	})
	if (res.code === 1 && names.length === 0) return []
	if (res.code === 0) return names
	return refuse(target, 'read its git config', res.stderr || `exit ${res.code}`)
}

/** Paths of the submodule entries (gitlinks) in this repository's index, relative to its work tree. */
async function listGitlinks(target: ScanTarget, env: Record<string, string>): Promise<string[]> {
	const paths = new Set<string>()
	const res = await scanGit([...target.args, 'ls-files', '-z', '--stage'], env, (record) => {
		const path = gitlinkPathFromStageRecord(record)
		if (path === null) return
		if (paths.size >= GIT_SCAN_LIMITS.gitlinks) throw new Error(`more than ${GIT_SCAN_LIMITS.gitlinks} submodule entries`)
		paths.add(path)
	})
	if (res.code !== 0) return refuse(target, 'list its submodules', res.stderr || `exit ${res.code}`)
	return [...paths]
}

/**
 * The work tree a git started in `dir` with `GIT_DIR=.git` uses — what git does for each
 * submodule. That is `dir` itself unless the submodule's `core.worktree` says otherwise.
 */
async function submoduleWorkTree(dir: string, env: Record<string, string>): Promise<string> {
	const res = await spawnGit(
		['--no-pager', ...hardenedConfigArgs(), '-C', dir, '--git-dir=.git', 'rev-parse', '--show-toplevel'],
		env,
		undefined,
		GIT_SCAN_LIMITS.timeoutMs,
		64 * 1024,
	)
	const top = res.stdout.trim()
	if (res.code !== 0 || !top) {
		return refuse({ args: [], label: dir }, 'find the submodule’s work tree', res.stderr || `exit ${res.code}`)
	}
	return resolve(top)
}

/**
 * The filter drivers a tree command could run, across the repository and every checked-out
 * submodule below it at any depth. Git starts a second git inside a submodule — `add`
 * checks whether each one is dirty, and nothing on the command line stops that — and the
 * second git reads the submodule's own config. It inherits our environment, so the
 * overrides reach it; this finds the names to override.
 *
 * A submodule counts as checked out when `<path>/.git` exists, which is git's own test.
 */
async function treeFilterDrivers(repoPath: string, root: string | null, env: Record<string, string>): Promise<string[]> {
	const base = ['--no-pager', ...hardenedConfigArgs()]
	const drivers = new Set<string>()
	const addDrivers = (names: string[], target: ScanTarget) => {
		for (const driver of filterDriverNames(names)) {
			if (driver.length > GIT_SCAN_LIMITS.driverNameLength) refuse(target, 'use its filter drivers', 'a driver name is too long')
			drivers.add(driver)
			if (drivers.size > GIT_SCAN_LIMITS.filterDrivers) {
				refuse(target, 'use its filter drivers', `more than ${GIT_SCAN_LIMITS.filterDrivers} defined`)
			}
		}
	}

	const top: ScanTarget = { args: [...base, '-C', repoPath], label: repoPath }
	addDrivers(await readConfigNames(top, ['filter'], env), top)
	if (!root) return [...drivers]

	// Breadth-first over (work tree, git dir) pairs. The total cap bounds depth and loops.
	const queue: Array<{ workTree: string; gitArgs: string[]; label: string }> = [
		{ workTree: root, gitArgs: [...base, '-C', root, `--work-tree=${root}`], label: root },
	]
	const seen = new Set<string>()
	while (queue.length > 0) {
		const { workTree, gitArgs, label } = queue.shift()!
		for (const path of await listGitlinks({ args: gitArgs, label }, env)) {
			const dir = resolve(workTree, path)
			if (seen.has(dir) || !(await exists(join(dir, '.git')))) continue
			seen.add(dir)
			if (seen.size > GIT_SCAN_LIMITS.submodules) {
				refuse({ args: [], label }, 'scan its submodules', `more than ${GIT_SCAN_LIMITS.submodules} checked out`)
			}
			// `-C <dir> --git-dir=.git`, exactly how git starts the second git: a `.git` file
			// with a relative `gitdir:` resolves against the submodule directory.
			const sub: ScanTarget = { args: [...base, '-C', dir, '--git-dir=.git'], label: dir }
			addDrivers(await readConfigNames(sub, ['filter'], env), sub)
			const subTree = await submoduleWorkTree(dir, env)
			queue.push({ workTree: subTree, gitArgs: [...sub.args, `--work-tree=${subTree}`], label: dir })
		}
	}
	return [...drivers]
}

/**
 * Refuse a remote call from a repository whose config would change which URL git really
 * contacts, or carries URL-scoped `http.*` settings (see `remoteRedirectKeys`). The pins in
 * `remoteAccessConfig` hold for the URL we name; they do not follow a rewrite.
 */
async function assertRemoteNotRedirected(repoPath: string, url: string, env: Record<string, string>): Promise<void> {
	const target: ScanTarget = { args: ['--no-pager', ...hardenedConfigArgs(), '-C', repoPath], label: repoPath }
	const names = await readConfigNames(target, scanSectionsFor({ tree: false, remote: true }), env)
	const redirects = remoteRedirectKeys(names, url)
	if (redirects.length === 0) return
	throw new GitRefusedError(
		`Refusing to contact ${url} from ${repoPath}: its git config changes where or how that URL is reached ` +
			`(${redirects.slice(0, 5).join(', ')}). Nothing was run. Remove those settings from .git/config and retry.`,
	)
}

/**
 * Run `git <args>` hardened. `args[0]` is the subcommand; global options come from
 * `options`. Output is returned as text with the remote's token redacted, and a git
 * failure comes back as a non-zero `code`, not an exception. The one exception is
 * `GitRefusedError`: the pre-run scan found the repository unsafe to run in, and nothing
 * was run.
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
		const scanEnv = buildHardenedGitEnv(process.env)
		if (options.remote) await assertRemoteNotRedirected(options.repoPath, options.remote.url, scanEnv)
		if (needsTreeProtection(subcommand)) {
			const root = await findWorkTreeRoot(options.repoPath)
			configEntries.push(...overridesForFilterDrivers(await treeFilterDrivers(options.repoPath, root, scanEnv)))
			if (pinsWorkTree(subcommand) && root) globalArgs.push(`--work-tree=${root}`)
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
