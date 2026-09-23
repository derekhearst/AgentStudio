/**
 * The OS sandbox settings a run's `Bash` gets (`src/lib/engine/engine-sandbox.ts`).
 *
 * Pure — no database, no server.
 *
 * The defect behind the `denyWrite` half: the containment guard makes a *file tool* that
 * writes a trusted project's configuration ask first, but a sandboxed shell never meets the
 * guard. `echo … > .claude/hooks/x.sh` rewrote a hook that the next turn ran as the app user,
 * outside the sandbox, with no approval card anywhere.
 */

import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { engineSandboxSettings, projectConfigWriteDenials } from '../src/lib/engine/engine-sandbox'

const ROOT = process.platform === 'win32' ? 'C:\\sandbox\\user-aaa\\projects\\p1' : '/sandbox/user-aaa/projects/p1'

test.describe('engine sandbox settings', () => {
	test('a shell command can never leave the sandbox, and is never auto-approved for being in it', () => {
		const sandbox = engineSandboxSettings({ authEnvNames: [], protectedProjectRoot: null })
		expect(sandbox.enabled).toBe(true)
		expect(sandbox.allowUnsandboxedCommands).toBe(false)
		expect(sandbox.autoAllowBashIfSandboxed).toBe(false)
	})

	test("the CLI's login is unset inside the sandbox", () => {
		const sandbox = engineSandboxSettings({ authEnvNames: ['CLAUDE_CODE_OAUTH_TOKEN'], protectedProjectRoot: null })
		expect(sandbox.credentials?.envVars).toEqual([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', mode: 'deny' }])
	})

	test("a trusted project's configuration cannot be written from the shell", () => {
		const sandbox = engineSandboxSettings({ authEnvNames: [], protectedProjectRoot: ROOT })
		const denied = sandbox.filesystem?.denyWrite ?? []
		for (const segments of [
			['.claude', 'hooks'],
			['.claude', 'skills'],
			['.claude', 'settings.json'],
			['.claude', 'settings.local.json'],
			['CLAUDE.md'],
			['CLAUDE.local.md'],
			['.mcp.json'],
		]) {
			expect(denied, segments.join('/')).toContain(join(ROOT, ...segments))
		}
		// Absolute, so the CLI cannot read them relative to anything else.
		expect(projectConfigWriteDenials(ROOT).every((path) => path.startsWith(ROOT))).toBe(true)
	})

	test('a run that loads no project configuration adds no write denials', () => {
		// Nothing it could rewrite is loaded by a later turn; the CLI's own list still applies.
		expect(engineSandboxSettings({ authEnvNames: [], protectedProjectRoot: null }).filesystem).toBeUndefined()
	})
})
