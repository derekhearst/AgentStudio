/**
 * Hardened invocation for every git process the server runs — the pure half.
 *
 * ## Why this exists
 *
 * The server runs git outside the Bash sandbox, in directories the agent can write: project
 * clones, repo mirrors, worktrees. Git reads `.git/config` from whatever repository it is
 * pointed at, and a surprising number of config keys name a program to run:
 * `core.fsmonitor` runs on `status`, `add` and `fetch`; `filter.<x>.clean` runs on `add`,
 * `status` and `diff`; `diff.<x>.command` and `textconv` run on `diff`; hooks run on
 * `commit` and `push`; `core.alternateRefsCommand` runs on `fetch`. Other keys redirect
 * where a token goes: `url.<x>.insteadOf`, `http.<url>.proxy` with `sslVerify=false`, a
 * repo-local credential helper that receives the token on `store`. So an agent that can
 * write one file could run a command as the app user — with `DATABASE_URL` and
 * `APP_ENCRYPTION_KEY` in its environment — or walk off with the GitHub token.
 *
 * Git has no switch that ignores the repository's own config. What it does have is a fixed
 * precedence: config given on the command line (`-c`) or through `GIT_CONFIG_COUNT` is
 * read after every config file, so it wins. This module lists the overrides, and
 * `git-exec.server.ts` applies them to every call. Nothing else in the codebase is allowed
 * to spawn git.
 *
 * ## What each call gets
 *
 *   - `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL=/dev/null`: the host's own git config
 *     (credential managers, url rewrites, LFS filters) plays no part.
 *   - A short environment allowlist instead of `process.env`, so a command that does get
 *     run would find no secrets to read.
 *   - `-c` overrides for the keys that run programs (hooks, fsmonitor, askpass, signing,
 *     alternate refs) and an empty `credential.helper`, which clears every helper that any
 *     config file registered.
 *   - Overrides for every `filter.<driver>` the repository defines — and every checked-out
 *     submodule inside it, because git starts a second git in each one (`add` checks
 *     whether it is dirty) and that git reads the submodule's own config. Driver names are
 *     chosen by the repository, so they are read first (`git config --name-only`, which
 *     runs nothing) and neutralised by name. The overrides travel in the environment, which
 *     the second git inherits.
 *   - `--no-ext-diff --no-textconv --submodule=short` on diff-producing commands, and
 *     `--ignore-submodules=dirty` on `status`/`diff`, so they never start a git inside a
 *     submodule to diff or inspect it. The same defaults go in as `-c` keys for the
 *     commands that print a diff or a status on the side (`commit`, `checkout`).
 *   - `--work-tree` pinned to the directory holding `.git`, so `core.worktree` cannot point
 *     a status or diff at files outside the workspace.
 *   - `GIT_ALLOW_PROTOCOL=https` (plus `http` for a plain-http clone URL), which overrides
 *     every `protocol.*` key — no `ext::` or `file://` transport, however the URL was
 *     rewritten.
 *
 * ## Failing closed
 *
 * The overrides are only as good as the scan that finds the names. If that scan cannot be
 * completed — the config will not parse, it names more drivers or submodules than the
 * limits below, it times out — the command is refused (`GitRefusedError`), never run
 * without them.
 *
 * ## How the token travels
 *
 * As an `Authorization` header scoped to the exact remote URL, delivered through
 * `GIT_CONFIG_COUNT` so it is in neither argv nor any file. No credential helper, no askpass.
 * A header keyed to one URL is not sent anywhere else. The same-URL `http.*` keys that could
 * route the request through someone else or write files (`proxy`, `sslVerify`,
 * `curloptResolve`, `cookieFile`, `saveCookies`) are pinned at that URL too, where the
 * later, equally specific entry wins.
 *
 * A repository that would change which URL git actually contacts — `url.<x>.insteadOf`,
 * `pushInsteadOf`, a `remote.<that url>.*` section — or that carries URL-scoped `http.*`
 * settings is refused outright on any call that talks to a remote: once the URL is
 * rewritten, the pins above no longer apply to the URL git uses.
 *
 * Pure: no `node:` imports, so specs can pin the argv and environment without spawning.
 */

/** A path under which nothing can exist. `core.hooksPath` here means "no hooks at all". */
export const GIT_NULL_PATH = '/dev/null'

/**
 * `-c key=value` pairs every invocation carries. Command-line config is read last, so each
 * of these beats the repository's `.git/config`.
 */
export const HARDENED_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
	// Hooks never run: `<GIT_NULL_PATH>/<hook>` cannot exist.
	['core.hooksPath', GIT_NULL_PATH],
	// fsmonitor is a command git runs on status, add and fetch.
	['core.fsmonitor', 'false'],
	// An askpass program would run the moment a remote asks for credentials.
	['core.askPass', ''],
	// Runs while fetching into a repository that lists alternates. `true` prints nothing.
	['core.alternateRefsCommand', 'true'],
	// An empty value clears every helper any config file registered; none is added back.
	['credential.helper', ''],
	// Signing and signature checks call `gpg.program`, which the repository chooses.
	['commit.gpgSign', 'false'],
	['tag.gpgSign', 'false'],
	['push.gpgSign', 'false'],
	['log.showSignature', 'false'],
	['merge.verifySignatures', 'false'],
	// No recursion into submodules, whose config and attributes we have not read.
	['submodule.recurse', 'false'],
	['fetch.recurseSubmodules', 'false'],
	['push.recurseSubmodules', 'no'],
	// A submodule's change is one summary line, never an inline diff or log produced by a
	// git started inside the submodule, where its own diff programs would apply.
	['diff.submodule', 'short'],
	['status.submoduleSummary', 'false'],
	// Where commit and checkout report local changes, a dirty submodule is not inspected.
	['diff.ignoreSubmodules', 'dirty'],
	// No background gc or maintenance outliving the call with our environment.
	['gc.auto', '0'],
	['maintenance.auto', 'false'],
]

/**
 * Environment variables passed through from the server's own environment. Everything else
 * — `DATABASE_URL`, `APP_ENCRYPTION_KEY`, model keys — stays out of git's reach. Matched
 * case-insensitively because Windows spells `Path` its own way.
 */
const ENV_PASSTHROUGH = new Set([
	'PATH',
	'HOME',
	'TMPDIR',
	'TEMP',
	'TMP',
	'TZ',
	// Operator-level network and TLS setup is trusted; it is not the repository's to set.
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'CURL_CA_BUNDLE',
	'GIT_SSL_CAINFO',
	'GIT_SSL_CAPATH',
	// Windows needs these to start a process and open a socket at all.
	'SYSTEMROOT',
	'WINDIR',
	'COMSPEC',
	'PATHEXT',
	'SYSTEMDRIVE',
	'USERPROFILE',
	'HOMEDRIVE',
	'HOMEPATH',
	'APPDATA',
	'LOCALAPPDATA',
	'PROGRAMDATA',
	'PROGRAMFILES',
	'NUMBER_OF_PROCESSORS',
	'PROCESSOR_ARCHITECTURE',
	'OS',
])

/**
 * Subcommands that never touch the working tree or the index, so they cannot run a filter
 * driver and need neither the driver scan nor a pinned work tree. Anything not listed is
 * treated as able to — the safe default for a command added later.
 */
const TREE_FREE_COMMANDS = new Set([
	'branch',
	'cat-file',
	'clone',
	'config',
	'fetch',
	'for-each-ref',
	'init',
	'log',
	'ls-remote',
	'merge-base',
	'push',
	'remote',
	'rev-list',
	'rev-parse',
	'show-ref',
	'symbolic-ref',
	'update-ref',
	'version',
])

/**
 * Commands whose work tree is pinned with `--work-tree`, so `core.worktree` cannot aim them
 * at another directory. `worktree` is deliberately absent: `worktree add` checks the new
 * tree out in a child git whose `GIT_WORK_TREE` git sets itself.
 */
const WORK_TREE_COMMANDS = new Set([
	'add',
	'checkout',
	'clean',
	'commit',
	'diff',
	'merge',
	'mv',
	'reset',
	'restore',
	'rm',
	'stash',
	'status',
	'switch',
])

export type GitRemoteAccess = {
	/** Exactly the URL handed to git. Overrides and the auth header are scoped to it. */
	url: string
	/** GitHub OAuth tokens authenticate as `x-access-token`. */
	username?: string
	/** Omit (or pass empty) for anonymous access. */
	token?: string
}

export type GitConfigEntry = readonly [key: string, value: string]

/**
 * Thrown instead of running git when the pre-run scan could not establish that the call is
 * safe: the repository's config would not parse or is too large to read in full, or it
 * redirects the remote this call talks to. Nothing has run when this is thrown.
 */
export class GitRefusedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'GitRefusedError'
	}
}

/**
 * How much the pre-run scans will read before refusing. Real repositories sit far below
 * each: a handful of filter drivers (LFS is one), a few submodules. The driver limit also
 * keeps the override block well inside Windows' 32 KB environment.
 */
export const GIT_SCAN_LIMITS = {
	/** Matching config entries read from one repository. */
	configEntries: 1024,
	/** Distinct filter drivers across the repository and its submodules. */
	filterDrivers: 32,
	/** Length of one driver name. */
	driverNameLength: 128,
	/** Submodule entries (gitlinks) in one index. */
	gitlinks: 4096,
	/** Checked-out submodules, at any depth, whose config is read. */
	submodules: 32,
	/** Wall-clock budget for each scan. */
	timeoutMs: 30_000,
} as const

/** `section.sub.section.key` → its parts. The subsection is everything between the first and last dot. */
export function parseConfigName(name: string): { section: string; subsection: string | null; key: string } | null {
	const first = name.indexOf('.')
	const last = name.lastIndexOf('.')
	if (first <= 0 || last === name.length - 1) return null
	return {
		section: name.slice(0, first).toLowerCase(),
		subsection: last > first ? name.slice(first + 1, last) : null,
		key: name.slice(last + 1).toLowerCase(),
	}
}

/** The config sections the pre-run scan reads for a call: filters for tree commands, redirects for remote calls. */
export function scanSectionsFor(opts: { tree: boolean; remote: boolean }): string[] {
	return [...(opts.tree ? ['filter'] : []), ...(opts.remote ? ['url', 'remote', 'http'] : [])]
}

/**
 * Config entries (from the scan) that would change where a call to `remoteUrl` goes, or
 * how it is made, beyond what `remoteAccessConfig` pins:
 *
 *   - `url.<base>.insteadOf` / `pushInsteadOf` rewrite the URL before anything else applies;
 *   - `remote.<remoteUrl>.*` makes the URL a named remote with its own `url`, `pushurl`,
 *     `vcs` helper or `mirror` (which turns a push into a forced mirror);
 *   - any URL-scoped `http.<url>.*` key — the settings a rewritten URL would pick up, and
 *     the unpinned ones (`sslCAInfo`, `sslCert`) for this URL.
 *
 * Unscoped `http.*` keys are left alone: for this URL the pinned, URL-scoped values win.
 */
export function remoteRedirectKeys(configNames: readonly string[], remoteUrl: string): string[] {
	const target = remoteUrl.toLowerCase()
	return configNames.filter((raw) => {
		const parts = parseConfigName(raw)
		if (!parts || parts.subsection === null) return false
		if (parts.section === 'url') return parts.key === 'insteadof' || parts.key === 'pushinsteadof'
		if (parts.section === 'remote') return parts.subsection.toLowerCase() === target
		return parts.section === 'http'
	})
}

/** Distinct filter-driver names in the scan output (`filter.<driver>.<key>`). */
export function filterDriverNames(configNames: readonly string[]): string[] {
	const drivers = new Set<string>()
	for (const raw of configNames) {
		const parts = parseConfigName(raw)
		if (parts?.section === 'filter' && parts.subsection !== null) drivers.add(parts.subsection)
	}
	return [...drivers]
}

/**
 * The path of a submodule entry from one `git ls-files -z --stage` record
 * (`<mode> <object> <stage>\t<path>`), or null for anything that is not a gitlink.
 */
export function gitlinkPathFromStageRecord(record: string): string | null {
	if (!record.startsWith('160000 ')) return null
	const tab = record.indexOf('\t')
	return tab === -1 || tab === record.length - 1 ? null : record.slice(tab + 1)
}

export function needsTreeProtection(subcommand: string): boolean {
	return !TREE_FREE_COMMANDS.has(subcommand)
}

export function pinsWorkTree(subcommand: string): boolean {
	return WORK_TREE_COMMANDS.has(subcommand)
}

/**
 * Flags inserted straight after the subcommand. Where git has a command-line flag it beats
 * every config key, including per-submodule ones a `-c` default cannot reach.
 */
export function subcommandHardeningFlags(subcommand: string, args: readonly string[]): string[] {
	const has = (prefix: string) => args.some((a) => a === prefix || a.startsWith(`${prefix}=`))
	const flags: string[] = []
	if (subcommand === 'diff' || subcommand === 'log' || subcommand === 'show') {
		// `--submodule=short`: `diff` would start a git inside the submodule to diff it, and
		// that git neither sees `--no-ext-diff` nor stops at the submodule's diff programs.
		flags.push('--no-ext-diff', '--no-textconv', '--submodule=short')
	}
	if ((subcommand === 'diff' || subcommand === 'status') && !has('--ignore-submodules')) {
		flags.push('--ignore-submodules=dirty')
	}
	if (subcommand === 'fetch' || subcommand === 'push') {
		if (!has('--recurse-submodules')) flags.push('--recurse-submodules=no')
	}
	if (subcommand === 'push') flags.push('--no-verify')
	return flags
}

/** The global `-c` arguments, in order. Caller-supplied extras go first so ours win. */
export function hardenedConfigArgs(extra: readonly string[] = []): string[] {
	const args: string[] = []
	for (const pair of extra) args.push('-c', pair)
	for (const [key, value] of HARDENED_GIT_CONFIG) args.push('-c', `${key}=${value}`)
	return args
}

/**
 * Overrides for every filter driver named in `configNames` (the output of
 * `git config --name-only --get-regexp '^filter\.'`). An empty command disables the driver;
 * `required=false` keeps git from treating the disabled driver as a failure.
 */
export function filterDriverOverrides(configNames: readonly string[]): GitConfigEntry[] {
	return overridesForFilterDrivers(filterDriverNames(configNames))
}

/** The overrides that switch off each named filter driver. */
export function overridesForFilterDrivers(drivers: Iterable<string>): GitConfigEntry[] {
	const entries: GitConfigEntry[] = []
	for (const driver of drivers) {
		entries.push(
			[`filter.${driver}.clean`, ''],
			[`filter.${driver}.smudge`, ''],
			[`filter.${driver}.process`, ''],
			[`filter.${driver}.required`, 'false'],
		)
	}
	return entries
}

/** The operator's proxy for this URL, from the server environment — never the repo's. */
export function operatorProxyFor(url: string, env: Record<string, string | undefined>): string {
	const pick = (...names: string[]) => {
		for (const name of names) {
			const value = env[name]
			if (value) return value
		}
		return ''
	}
	if (/^https:/i.test(url)) return pick('https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY')
	if (/^http:/i.test(url)) return pick('http_proxy', 'all_proxy', 'ALL_PROXY')
	return ''
}

/** `Authorization` header value git sends to the remote. Basic, as GitHub's git endpoint expects. */
export function basicAuthHeader(username: string, token: string): string {
	return `Authorization: Basic ${btoa(`${username}:${token}`)}`
}

/**
 * Config entries scoped to one remote URL. Each is as specific as a key can get for that
 * URL, and comes after the repository's config, so it wins over anything the repository
 * says about the same URL. The header is cleared first: a repository cannot pre-load an
 * extra header next to ours.
 */
export function remoteAccessConfig(remote: GitRemoteAccess, proxy: string): GitConfigEntry[] {
	const url = remote.url
	const entries: GitConfigEntry[] = [
		[`http.${url}.sslVerify`, 'true'],
		[`http.${url}.proxy`, proxy],
		[`http.${url}.curloptResolve`, ''],
		[`http.${url}.followRedirects`, 'initial'],
		// A cookie jar is a file curl writes wherever it is told — another tenant's file, say.
		[`http.${url}.cookieFile`, ''],
		[`http.${url}.saveCookies`, 'false'],
		[`http.${url}.extraHeader`, ''],
		// `remote.<name>.proxy` beats `http.proxy`, and a URL is its own remote name.
		[`remote.${url}.proxy`, proxy],
	]
	if (remote.token) {
		entries.push([`http.${url}.extraHeader`, basicAuthHeader(remote.username || 'x-access-token', remote.token)])
	}
	return entries
}

/** Protocols git may use. `http` only when the remote itself is a plain-http URL. */
export function allowedProtocolsFor(remoteUrl: string | undefined): string {
	return remoteUrl && /^http:/i.test(remoteUrl) ? 'https:http' : 'https'
}

/**
 * The child environment: an allowlist of the server's variables, plus the switches that
 * take the host's git config out of play and the dynamic config entries.
 */
export function buildHardenedGitEnv(
	base: Record<string, string | undefined>,
	opts: { configEntries?: readonly GitConfigEntry[]; remoteUrl?: string } = {},
): Record<string, string> {
	const env: Record<string, string> = {}
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined && ENV_PASSTHROUGH.has(key.toUpperCase())) env[key] = value
	}
	env.GIT_CONFIG_NOSYSTEM = '1'
	env.GIT_CONFIG_GLOBAL = GIT_NULL_PATH
	env.GIT_TERMINAL_PROMPT = '0'
	// Set but empty: git stops looking for an askpass program here, including SSH_ASKPASS.
	env.GIT_ASKPASS = ''
	// ':' is git's own spelling of "no editor".
	env.GIT_EDITOR = ':'
	env.GIT_PAGER = 'cat'
	env.GIT_ALLOW_PROTOCOL = allowedProtocolsFor(opts.remoteUrl)
	// Messages the callers match on ("nothing to commit") must not be translated.
	env.LC_ALL = 'C'
	const entries = opts.configEntries ?? []
	env.GIT_CONFIG_COUNT = String(entries.length)
	entries.forEach(([key, value], i) => {
		env[`GIT_CONFIG_KEY_${i}`] = key
		env[`GIT_CONFIG_VALUE_${i}`] = value
	})
	return env
}

/** Strip a secret (and its Basic-encoded form) from text that is about to be returned. */
export function redactGitSecret(text: string, remote: GitRemoteAccess | undefined): string {
	if (!remote?.token) return text
	let out = text.split(remote.token).join('***REDACTED***')
	const encoded = btoa(`${remote.username || 'x-access-token'}:${remote.token}`)
	out = out.split(encoded).join('***REDACTED***')
	return out
}

// ─────────── Argument validation ───────────

/**
 * A revision a model or user may name: `HEAD~2`, `main...feature`, `origin/main`,
 * `HEAD@{1}`, a sha. Never starting with `-` — git would read that as an option, and
 * `--output=<path>` would have the server write the diff wherever it was told.
 */
const SAFE_REVISION = /^(?!-)[A-Za-z0-9._/~^@{}+-]{1,256}$/

export function isSafeRevision(value: string): boolean {
	return SAFE_REVISION.test(value)
}

export function assertSafeRevision(value: string, kind = 'ref'): string {
	if (!isSafeRevision(value)) {
		throw new Error(`Invalid ${kind}: ${JSON.stringify(value)}. Use a branch, tag, commit or HEAD~N; it may not start with "-".`)
	}
	return value
}

/**
 * A branch name git would accept and that cannot be mistaken for an option or a refspec:
 * no leading `-`, no `..`, `//`, `@{`, `:` or wildcard, no trailing `/`, `.` or `.lock`.
 */
export function isSafeBranchName(value: string): boolean {
	if (!/^(?!-)[A-Za-z0-9._/+-]{1,200}$/.test(value)) return false
	if (value.includes('..') || value.includes('//') || value.startsWith('/')) return false
	if (value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return false
	return !value.split('/').some((segment) => segment.startsWith('.'))
}

export function assertSafeBranchName(value: string): string {
	if (!isSafeBranchName(value)) throw new Error(`Invalid branch name: ${JSON.stringify(value)}`)
	return value
}
