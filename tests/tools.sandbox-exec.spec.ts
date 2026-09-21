/**
 * Confinement plan for spawned children (#54).
 *
 * Pure — asserts the argv, not a live bubblewrap, so it runs on any platform. The live
 * behaviour is checked separately against a container that actually has bwrap; what this
 * pins is the shape, because the mistakes that matter here are structural: forgetting the
 * `--` separator, binding the workspace read-only, or exposing a path nobody meant to.
 */

import { expect, test } from '@playwright/test'
import { planConfinedSpawn } from '../src/lib/tools/sandbox-exec.server'

const WS = '/sandbox/user-aaa/projects/p1'

const confined = () =>
	planConfinedSpawn({ command: 'bun', args: ['run', '/tmp/boot.ts'], workspace: WS, available: true })

test('a confined plan runs the command through bwrap', () => {
	const plan = confined()
	expect(plan.confined).toBe(true)
	expect(plan.command).toBe('bwrap')
	// Everything after `--` is the command; everything before is sandbox configuration.
	const sep = plan.args.indexOf('--')
	expect(sep, 'the -- separator must be present').toBeGreaterThan(0)
	expect(plan.args.slice(sep + 1)).toEqual(['bun', 'run', '/tmp/boot.ts'])
})

test('the workspace is the only writable bind', () => {
	const plan = confined()
	const sep = plan.args.indexOf('--')
	const sandboxArgs = plan.args.slice(0, sep)

	// `--bind` is read-write. The workspace should be the only one.
	const writable: string[] = []
	for (let i = 0; i < sandboxArgs.length; i++) {
		if (sandboxArgs[i] === '--bind') writable.push(sandboxArgs[i + 1])
	}
	expect(writable).toEqual([WS])

	// System paths are present but read-only.
	expect(sandboxArgs).toContain('--ro-bind-try')
	const roIndex = sandboxArgs.indexOf('--ro-bind-try')
	expect(sandboxArgs[roIndex + 1]).toMatch(/^\//)
})

test('the child cannot signal or outlive the server that spawned it', () => {
	const args = confined().args
	expect(args).toContain('--unshare-pid')
	expect(args).toContain('--die-with-parent')
	expect(args).toContain('--new-session')
})

test('the working directory is the workspace, not the server process cwd', () => {
	const args = confined().args
	const i = args.indexOf('--chdir')
	expect(i).toBeGreaterThan(-1)
	expect(args[i + 1]).toBe(WS)
})

test('an unavailable sandbox returns the bare command, flagged', () => {
	const plan = planConfinedSpawn({
		command: 'bun',
		args: ['run', '/tmp/boot.ts'],
		workspace: WS,
		available: false,
	})
	// The caller must be able to tell the difference and refuse; silently returning a
	// bwrap-looking plan that isn't confined is the failure this flag exists to prevent.
	expect(plan.confined).toBe(false)
	expect(plan.command).toBe('bun')
	expect(plan.args).toEqual(['run', '/tmp/boot.ts'])
})

test('a sibling workspace is never bound', () => {
	const plan = confined()
	const joined = plan.args.join(' ')
	expect(joined).not.toContain('/sandbox/user-bbb')
	expect(joined).not.toContain('/etc/shadow')
	expect(joined).not.toContain('/root')
})

test('the tmpfs over /tmp does not hide the workspace', () => {
	// run_code writes its bootstrap, user script and TMPDIR under the workspace
	// (`.run-code/`, `.tmp/`), not /tmp — so replacing /tmp with an empty tmpfs cannot
	// hide them. This pins that relationship: if scratch files ever move to /tmp, the
	// tmpfs would shadow them and every run would fail to start.
	const plan = confined()
	const args = plan.args
	const tmpfsAt = args.indexOf('--tmpfs')
	const bindAt = args.indexOf('--bind')
	expect(tmpfsAt).toBeGreaterThan(-1)
	expect(args[tmpfsAt + 1]).toBe('/tmp')
	expect(bindAt).toBeGreaterThan(-1)
	expect(args[bindAt + 1]).toBe(WS)
	expect(WS.startsWith('/tmp')).toBe(false)
})
