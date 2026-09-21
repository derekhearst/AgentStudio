/**
 * OS-level confinement for child processes we spawn ourselves (#54).
 *
 * `run_code` evaluates the model's script in a `bun` child process. The `tools` proxy it
 * exposes is a real gate — approvals, mandatory-approval tools and per-agent policy all
 * apply to anything called through it — but it is not a boundary: the script is ordinary
 * JavaScript, so `await import('node:fs/promises')` reaches the host filesystem directly,
 * and `cwd` does not constrain an absolute path.
 *
 * That was true before #15 and survived it: `Read`/`Write`/`Edit`/`Glob`/`Grep` are
 * confined by `engine/workspace-guard.ts` and `Bash` by the Agent SDK's own bubblewrap
 * sandbox, which left `run_code` as the one path to the filesystem with nothing in front
 * of it. This module closes that by wrapping the spawn in the same bubblewrap the SDK uses.
 *
 * ## What the sandbox does and does not cover
 *
 * Covered: the filesystem. The script sees a read-only view of the system directories it
 * needs to run, a writable workspace, and nothing else — no `/etc/shadow`, no sibling
 * user's workspace, no writing outside its own tree.
 *
 * **Not covered: the network.** The bootstrap talks to the tool-RPC server over loopback
 * (`http://127.0.0.1:<port>/tool`), so the network namespace has to stay shared or every
 * tool call from inside a script breaks. A script therefore still has whatever network
 * access the container has. Closing that means moving the RPC to a unix socket bind-mounted
 * into the sandbox and then `--unshare-net`; worth doing, deliberately not done here,
 * because a half-applied network jail that silently breaks tool calls is worse than an
 * honest filesystem-only one.
 */

import { spawnSync } from 'node:child_process'
import { logger } from '$lib/observability/logger'

/** Read-only system paths a `bun` child needs to start. Missing entries are skipped. */
const SYSTEM_ROOTS = ['/usr', '/bin', '/lib', '/lib64', '/sbin', '/etc/ssl', '/etc/ca-certificates']

let probed: boolean | null = null

/**
 * Whether bubblewrap can actually run here, probed once per process.
 *
 * Deliberately executes `bwrap --version` rather than checking the platform: the binary
 * can be present but unusable (no user namespaces, a restrictive seccomp profile), and a
 * sandbox that is assumed rather than verified is the failure mode this whole area exists
 * to avoid.
 */
export function bubblewrapAvailable(): boolean {
	if (probed !== null) return probed
	if (process.platform !== 'linux') {
		probed = false
		return probed
	}
	try {
		const result = spawnSync('bwrap', ['--version'], { stdio: 'ignore', timeout: 5000 })
		probed = result.status === 0
	} catch {
		probed = false
	}
	if (!probed) {
		logger.warn('[sandbox-exec] bubblewrap unavailable; child processes cannot be confined')
	}
	return probed
}

/** For tests: forget the probe so a fixture can drive both branches. */
export function resetBubblewrapProbe(): void {
	probed = null
}

export type SandboxSpawnPlan = {
	command: string
	args: string[]
	/** False when the plan runs the command directly because no sandbox is available. */
	confined: boolean
}

/**
 * Build the argv that runs `command args…` confined to `workspace`.
 *
 * Returns the command unchanged with `confined: false` when bubblewrap is unavailable —
 * the caller decides what to do about that, because the right answer differs between a
 * developer's machine and a production container.
 */
export function planConfinedSpawn(input: {
	command: string
	args: readonly string[]
	workspace: string
	/** Extra paths to expose read-only, e.g. a bun install cache outside the workspace. */
	readOnlyPaths?: readonly string[]
	available?: boolean
}): SandboxSpawnPlan {
	const available = input.available ?? bubblewrapAvailable()
	if (!available) {
		return { command: input.command, args: [...input.args], confined: false }
	}

	const args: string[] = []
	for (const root of [...SYSTEM_ROOTS, ...(input.readOnlyPaths ?? [])]) {
		// `--ro-bind-try` skips a path that does not exist instead of failing the spawn,
		// which keeps the same plan working across base images.
		args.push('--ro-bind-try', root, root)
	}

	args.push(
		'--bind', input.workspace, input.workspace,
		'--proc', '/proc',
		'--dev', '/dev',
		'--tmpfs', '/tmp',
		// No new privileges, and give the child its own PID namespace so it cannot signal
		// the server process that spawned it.
		'--unshare-pid',
		'--unshare-uts',
		'--unshare-ipc',
		'--die-with-parent',
		'--new-session',
		'--chdir', input.workspace,
	)

	args.push('--', input.command, ...input.args)
	return { command: 'bwrap', args, confined: true }
}
