/**
 * The OS sandbox settings a run's `Bash` gets (#15), as data.
 *
 * Kept out of `options.server.ts` for the same reason as `./builtin-tools`: a spec has to be
 * able to read them, and importing the server module from the Playwright runtime fails on
 * `$env`.
 *
 * ## Why a trusted project's configuration is write-protected here too
 *
 * `./workspace-guard` makes a file tool that writes the agent's own configuration ask first
 * — `.claude/settings.json`, `.claude/hooks/**`, `CLAUDE.md` and the rest. But a sandboxed
 * shell writes files as well, and it never meets that check: `echo … > .claude/hooks/x.sh`
 * is just a command. The CLI's own sandbox refuses writes to its settings files, `.mcp.json`
 * and some of `.claude/`, not every path a trusted project loads. A hook script changed that
 * way runs on the next turn as the app user, outside the sandbox.
 *
 * So when a run loads the project's committed configuration, every path it loads from is
 * listed in `filesystem.denyWrite` as well. A shell command in the sandbox then cannot
 * create, change, move or delete them at all; the file tools still can, with an approval
 * card. The lists overlap the CLI's own on purpose — nothing here depends on what a given
 * CLI version happens to protect.
 *
 * Only the project root is covered. The CLI also loads a `CLAUDE.md` it finds in a
 * subdirectory once the agent works there; those cannot be listed ahead of time, and stay
 * protected by the guard's approval card only.
 */

import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

export type EngineSandboxSettings = NonNullable<Options['sandbox']>

/** What the project tier loads from a checkout, relative to its root. */
export const PROJECT_CONFIG_PATHS: readonly (readonly string[])[] = [
	['.claude', 'settings.json'],
	['.claude', 'settings.local.json'],
	['.claude', 'hooks'],
	['.claude', 'skills'],
	['.claude', 'commands'],
	['.claude', 'agents'],
	['.claude', 'rules'],
	['.mcp.json'],
	['CLAUDE.md'],
	['CLAUDE.local.md'],
]

/** The absolute paths a sandboxed shell may not write in a trusted project's checkout. */
export function projectConfigWriteDenials(projectRoot: string): string[] {
	return PROJECT_CONFIG_PATHS.map((segments) => join(projectRoot, ...segments))
}

export function engineSandboxSettings(input: {
	/** Names of the CLI's own login variables, to be unset inside the sandbox. */
	authEnvNames: readonly string[]
	/**
	 * The checkout whose committed configuration this run loads, or null when it loads none
	 * (the `project` setting source is off). See the module note.
	 */
	protectedProjectRoot: string | null
}): EngineSandboxSettings {
	return {
		enabled: true,
		autoAllowBashIfSandboxed: false,
		// The SDK otherwise honours Bash's `dangerouslyDisableSandbox` flag and runs the command
		// unconfined. `./workspace-guard` refuses the flag as well.
		allowUnsandboxedCommands: false,
		// The CLI needs its own login in its environment; a shell inside the sandbox does not,
		// and `env` there would print it. `deny` unsets it there.
		...(input.authEnvNames.length > 0
			? { credentials: { envVars: input.authEnvNames.map((name) => ({ name, mode: 'deny' as const })) } }
			: {}),
		...(input.protectedProjectRoot
			? { filesystem: { denyWrite: projectConfigWriteDenials(input.protectedProjectRoot) } }
			: {}),
	}
}
