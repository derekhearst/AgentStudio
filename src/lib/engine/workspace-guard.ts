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
 * So containment moves into `canUseTool`, which the SDK consults before every built-in
 * call, and this module is the decision.
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
 * Pure: no DB, no SvelteKit, no `node:fs`. `node:path` only, so it unit-tests without a
 * filesystem and cannot be defeated by a race between the check and the read.
 */

import { isAbsolute, resolve, sep } from 'node:path'

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

/** Tools that run a command rather than touch a named path. Not decidable from arguments. */
const COMMAND_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell'])

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
function pathArgumentsFor(toolName: string, toolInput: unknown): string[] {
	const keys = PATH_ARGS[toolName]
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

	const paths = pathArgumentsFor(toolName, toolInput)
	if (paths.length === 0) return { verdict: 'allow' }

	const roots = [workspaceRoot, ...(input.additionalRoots ?? [])]
	for (const candidate of paths) {
		// A relative path resolves against the workspace, which is also the SDK's cwd.
		const absolute = isAbsolute(candidate) ? candidate : resolve(workspaceRoot, candidate)
		if (!roots.some((root) => isInside(root, absolute))) {
			return {
				verdict: 'deny',
				reason: `Path is outside this run's workspace: ${candidate}`,
			}
		}
	}

	return { verdict: 'allow' }
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
