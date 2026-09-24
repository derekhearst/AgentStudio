/**
 * Workspace containment for the SDK's built-in tools (#15).
 *
 * ## Why this exists
 *
 * Every in-house filesystem tool routed through `safePath()` in `workspace.server.ts`,
 * which resolves a path inside the per-user workspace and throws if it escapes. That
 * function is the only reason a tool could not read `/etc/passwd` or write outside the
 * sandbox. #15 replaces those tools with the SDK's built-in `Read`/`Write`/`Edit`/`Bash`,
 * which call the filesystem directly and have never heard of it.
 *
 * `cwd` does not save us. It is a working directory, not a jail: `Read` with an absolute
 * path ignores it entirely. Deleting the wrappers without replacing the check would hand
 * the model unrestricted filesystem access on the host, which is a bigger regression than
 * the duplication #15 set out to fix.
 *
 * So containment moves into the engine's `PreToolUse` hook, which the SDK runs before every
 * call — ahead of allow rules and permission modes, which `canUseTool` is not — and this
 * module is the decision. See `./tool-decision`.
 *
 * ## What this can and cannot do
 *
 * Path-taking tools are decidable: resolve the argument, check containment, done.
 *
 * `Bash` is not. A command string is not a path, and any attempt to decide "does this
 * shell command stay inside the workspace" by reading it is security theatre — `sh -c`,
 * `$(…)`, a here-doc, a symlink, or `cd /` all defeat it, and a check that looks rigorous
 * while being bypassable is worse than an honest refusal because it invites trust.
 *
 * Bash is therefore contained by the operating system or not at all:
 *
 *   - where the SDK's `sandbox` option is available (Linux + bubblewrap, which production
 *     has), the OS confines the command and `bashPolicy` is 'sandboxed'
 *   - where it is not (a developer's Windows box), Bash cannot be contained, so the honest
 *     answers are to gate it on human approval or refuse it. `bashPolicy: 'ask'` and
 *     'deny' express those. What this module will not do is pretend.
 *
 * ## Symlinks
 *
 * A lexical check alone is not containment. Sandboxed Bash can `ln -s / root` inside the
 * workspace (it may write there), and an imported repo can commit such a link, after which
 * `Read root/etc/passwd` is lexically inside the workspace while the SDK's file tools, which
 * run outside the sandbox, open the host's file. So a path must also stay inside once
 * symlinks are resolved on both sides (see `resolveRealPath`). That is the only filesystem
 * access here, and it is injectable so the decision still unit-tests without a disk. It
 * runs wherever the decision does, the `PreToolUse` hook included, so it is judged again
 * just before the call runs. A link swapped between this check and the SDK's open can still
 * win that race; nothing short of `openat2(RESOLVE_BENEATH)` in the SDK itself would close it.
 *
 * The guard judges the argument as the SDK may spell it when it opens the file, without
 * relying on the SDK tidying it first. `a/link/../b` is resolved both as written (the
 * kernel follows `link` before applying `..`) and normalised, and both must stay inside.
 * A leading `~` is the SDK's home directory, not a folder in the workspace, so it is
 * refused outright.
 *
 * Our own file tools (`move_file`, `delete_file`, …) are not resolved here: they open paths
 * through `safePathWithin`, which applies the same real-path rule itself.
 *
 * No DB, no SvelteKit.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { resolveRealPath as resolveRealPathOnDisk } from '$lib/workspace/containment.server'

/** Built-in tools whose arguments name a path we can resolve and contain. */
const PATH_ARGS: Record<string, readonly string[]> = {
	Read: ['file_path', 'path', 'notebook_path'],
	Write: ['file_path', 'path'],
	Edit: ['file_path', 'path'],
	MultiEdit: ['file_path', 'path'],
	NotebookEdit: ['notebook_path', 'file_path', 'path'],
	Glob: ['path'],
	Grep: ['path'],
	LS: ['path'],
}

/** `~`, `~/x`, `~user/x`: a home directory once the SDK expands it. */
const HOME_PREFIX = /^~[A-Za-z0-9._-]*(?:[\\/]|$)/

/** A `..` component, with either slash (a stricter reading than POSIX needs, never looser). */
const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/

/**
 * Tools that run a command rather than touch a named path. Not decidable from arguments.
 *
 * Only `Bash`. `TaskStop` (the CLI's name for `KillShell`) names no path and can only stop a
 * task this session started, so it is not held for approval under `bashPolicy: 'ask'`;
 * `BashOutput` no longer exists as a tool (see `./builtin-tools`).
 */
const COMMAND_TOOLS = new Set(['Bash'])

/**
 * Tools that can create, change or remove a file, and the arguments that name it.
 *
 * Wider than the built-ins on purpose: our own `move_file` / `delete_file` resolve inside the
 * same workspace, and moving a file onto `.claude/settings.json` rewrites it just as
 * surely as `Write` does. Deleting one counts too — removing a trusted `permissions.deny`
 * is an escalation of its own.
 */
const CONFIG_WRITE_ARGS: Record<string, readonly string[]> = {
	Write: ['file_path', 'path'],
	Edit: ['file_path', 'path'],
	MultiEdit: ['file_path', 'path'],
	NotebookEdit: ['notebook_path', 'file_path', 'path'],
	move_file: ['fromPath', 'toPath'],
	delete_file: ['path'],
}

/**
 * What under `.claude/` configures the agent rather than being work it produced.
 *
 * The same set the SDK's own sandbox refuses to let a sandboxed `Bash` write (its settings
 * files, `commands`, `agents`, `skills`), plus `hooks` — a trusted project's hook commands
 * run as the app user, outside the sandbox.
 */
const CLAUDE_CONFIG_ENTRIES = new Set(['settings.json', 'settings.local.json', 'commands', 'agents', 'skills', 'hooks'])

/** Instruction files the project tier loads into every run's prompt once a project is trusted. */
const INSTRUCTION_FILES = new Set(['claude.md', 'claude.local.md'])

export type BashPolicy = 'sandboxed' | 'ask' | 'deny'

export type GuardInput = {
	toolName: string
	toolInput: unknown
	/** Absolute path of the run's workspace. Everything must resolve inside it. */
	workspaceRoot: string
	/**
	 * How `Bash` is contained in this environment. 'sandboxed' means the OS is doing it
	 * and this module steps aside; 'ask' routes to human approval; 'deny' refuses.
	 */
	bashPolicy: BashPolicy
	/** Extra roots the run may touch, e.g. a read-only skills directory. Absolute. */
	additionalRoots?: readonly string[]
	/**
	 * Whether this run loads the project's own committed configuration (the SDK's `project`
	 * setting source — see `./setting-sources`). When it does, the `CLAUDE.md` files are part
	 * of what the agent is told on every turn, so changing them needs approval too.
	 */
	projectConfigLoaded?: boolean
	/**
	 * Resolves every symlink in a path as the OS would open it, `..` included (a missing
	 * tail is kept as written). Defaults to the real filesystem; specs inject a fake. May
	 * throw, which counts as "cannot prove it stays inside".
	 */
	resolveRealPath?: (path: string) => string
}

export type GuardDecision =
	| { verdict: 'allow' }
	| { verdict: 'ask'; reason: string }
	| { verdict: 'deny'; reason: string }

function normalize(p: string): string {
	// Case-insensitive on Windows, and trailing separators must not change identity.
	const trimmed = p.replace(/[\\/]+$/, '')
	return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** True when `candidate` is `root` itself or lives underneath it. */
export function isInside(root: string, candidate: string): boolean {
	const r = normalize(resolve(root))
	const c = normalize(resolve(candidate))
	return c === r || c.startsWith(r + sep) || c.startsWith(r + '/')
}

/** Pull every string argument that names a path, by the conventions each built-in uses. */
function pathArgumentsFor(toolName: string, toolInput: unknown, table = PATH_ARGS): string[] {
	const keys = table[toolName]
	if (!keys || typeof toolInput !== 'object' || toolInput === null) return []
	const record = toolInput as Record<string, unknown>
	const found: string[] = []
	for (const key of keys) {
		const value = record[key]
		if (typeof value === 'string' && value.length > 0) found.push(value)
	}
	return found
}

/**
 * Decide whether a built-in tool call stays inside the run's workspace.
 *
 * Unknown tools return 'allow': this guard's job is filesystem containment, not tool
 * policy. Approval, permission mode and the mandatory-approval list are decided by
 * `resolveToolGate`, which runs alongside it — a tool that is not a filesystem tool is
 * simply not this function's business.
 */
export function guardWorkspaceAccess(input: GuardInput): GuardDecision {
	const { toolName, toolInput, workspaceRoot, bashPolicy } = input

	if (COMMAND_TOOLS.has(toolName)) {
		/*
		 * `Bash` takes a `dangerouslyDisableSandbox` flag that runs the command outside the
		 * OS sandbox, and the SDK honours it unless `allowUnsandboxedCommands` is false. That
		 * option is set too (`./options.server`), but a 'sandboxed' policy that waved the
		 * flag through would be claiming a confinement it had just been told to drop. Refused
		 * in every policy: where there is no sandbox the flag means nothing, and the model
		 * can simply ask again without it.
		 */
		if (
			typeof toolInput === 'object' &&
			toolInput !== null &&
			(toolInput as Record<string, unknown>).dangerouslyDisableSandbox === true
		) {
			return {
				verdict: 'deny',
				reason: 'Shell commands always run inside the sandbox here; dangerouslyDisableSandbox is not honoured.',
			}
		}
		if (bashPolicy === 'sandboxed') return { verdict: 'allow' }
		if (bashPolicy === 'ask') {
			return {
				verdict: 'ask',
				reason:
					'Shell commands cannot be confined to the workspace on this host, so each one needs explicit approval.',
			}
		}
		return {
			verdict: 'deny',
			reason:
				'Shell commands are disabled because this host cannot confine them to the workspace.',
		}
	}

	// A relative path resolves against the workspace, which is also the SDK's cwd — the
	// chat route passes the same root as both, so the two cannot resolve it differently.
	const absoluteFor = (candidate: string) => (isAbsolute(candidate) ? candidate : resolve(workspaceRoot, candidate))

	const paths = pathArgumentsFor(toolName, toolInput)
	const roots = [workspaceRoot, ...(input.additionalRoots ?? [])]
	const realPath = input.resolveRealPath ?? resolveRealPathOnDisk
	let realRoots: string[] | null = null
	for (const candidate of paths) {
		const outside = {
			verdict: 'deny',
			reason: `Path is outside this run's workspace: ${candidate}`,
		} as const
		// The SDK expands `~` to its home directory; `path.resolve` would call it a folder.
		if (HOME_PREFIX.test(candidate)) return outside

		const absolute = absoluteFor(candidate)
		if (!roots.some((root) => isInside(root, absolute))) return outside

		// Lexically fine; now the path the SDK will really open. `resolve` has already
		// collapsed any `..`, which is not what the kernel does after a link, so a spelling
		// with `..` is also resolved exactly as written.
		const spellings = [absolute]
		if (PARENT_SEGMENT.test(candidate)) {
			spellings.push(isAbsolute(candidate) ? candidate : `${workspaceRoot}${sep}${candidate}`)
		}
		// Resolved lazily so a call with no path argument never touches the disk.
		try {
			realRoots ??= roots.map((root) => realPath(root))
			for (const spelling of spellings) {
				const real = realPath(spelling)
				if (!realRoots.some((root) => isInside(root, real))) return outside
			}
		} catch {
			return outside
		}
	}

	/*
	 * Inside the workspace, but is it the agent's own configuration?
	 *
	 * A trusted project's `.claude/settings.json` is loaded by the next run, and its hooks run
	 * as the app user outside the sandbox — so an agent that could rewrite it could grant
	 * itself anything between turns, which is exactly why `./setting-sources` never loads
	 * the `local` tier. Trust is a decision about content the operator looked at, and that
	 * content sits in the agent's own writable directory. Asking rather than refusing keeps
	 * the legitimate case ("add a slash command for this repo") possible, with a human in it.
	 */
	for (const candidate of pathArgumentsFor(toolName, toolInput, CONFIG_WRITE_ARGS)) {
		if (isAgentConfigPath(workspaceRoot, absoluteFor(candidate), input.projectConfigLoaded === true)) {
			return {
				verdict: 'ask',
				reason: `${candidate} configures the agent itself (its permissions, hooks, commands or instructions), so changing it always needs your approval.`,
			}
		}
	}

	return { verdict: 'allow' }
}

/**
 * True when `absolute` is part of the configuration the SDK loads from a project rather
 * than something the agent produced. Matched per path segment and case-insensitively, so
 * `.Claude/Settings.json` on a case-insensitive filesystem cannot slip past.
 */
export function isAgentConfigPath(workspaceRoot: string, absolute: string, includeInstructions: boolean): boolean {
	// Relative to the workspace when inside it, so a workspace that itself lives under some
	// `.claude/` directory on the host is not mistaken for configuration.
	const rel = relative(workspaceRoot, absolute)
	const within = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
	const segments = (within ? rel : absolute)
		.split(/[\\/]+/)
		.filter((s) => s.length > 0 && s !== '.')
		.map((s) => s.toLowerCase())
	if (segments.length === 0) return false

	for (let i = 0; i < segments.length; i++) {
		if (segments[i] !== '.claude') continue
		// The directory itself (a move or recursive delete of `.claude`), or a config entry in it.
		if (i === segments.length - 1 || CLAUDE_CONFIG_ENTRIES.has(segments[i + 1])) return true
	}

	const base = segments[segments.length - 1]
	if (base === '.mcp.json') return true
	return includeInstructions && INSTRUCTION_FILES.has(base)
}

/**
 * Pick the Bash policy for the host the engine is running on.
 *
 * The SDK's OS sandbox needs Linux with bubblewrap. Production is Linux and the image
 * installs it; a developer box may be neither, and there the honest answer is to ask
 * rather than to allow silently.
 */
export function resolveBashPolicy(env: {
	platform?: string
	sandboxAvailable?: boolean
	override?: BashPolicy
}): BashPolicy {
	if (env.override) return env.override
	const platform = env.platform ?? process.platform
	if (platform === 'linux' && env.sandboxAvailable !== false) return 'sandboxed'
	return 'ask'
}
