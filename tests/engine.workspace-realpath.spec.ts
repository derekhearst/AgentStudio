import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { guardWorkspaceAccess } from '../src/lib/engine/workspace-guard'
import { realLocation, realPathEscape } from '../src/lib/engine/workspace-realpath.server'

/**
 * Containment once links are followed (`src/lib/engine/workspace-realpath.server.ts`).
 *
 * The guard decides lexically, so `x/etc/cron.d/job` is "inside" a workspace that holds a
 * link `x -> /`. Such a link can arrive in an imported repository, or be made by a sandboxed
 * shell command without writing anything outside the workspace — and the SDK's file tools
 * run outside the sandbox and follow it. Both halves are asserted: a link out is caught, and
 * ordinary paths (including ones that do not exist yet) are not.
 */

let base: string
let ws: string
let outside: string

test.beforeAll(async () => {
	base = await mkdtemp(resolve(tmpdir(), 'agentstudio-realpath-'))
	ws = join(base, 'ws')
	outside = join(base, 'outside')
	await mkdir(join(ws, 'src'), { recursive: true })
	await mkdir(outside, { recursive: true })
	await writeFile(join(ws, 'src', 'a.ts'), 'x')
	await writeFile(join(outside, 'secret.txt'), 'secret')
	// A junction needs no privilege on Windows; elsewhere it is an ordinary directory link.
	await symlink(outside, join(ws, 'escape'), 'junction')
	await symlink(join(ws, 'src'), join(ws, 'alias'), 'junction')
})

test.afterAll(async () => {
	await rm(base, { recursive: true, force: true })
})

test('a link out of the workspace is lexically inside — which is the problem', () => {
	// Pinned so the reason this module exists stays visible: the pure guard allows it.
	const verdict = guardWorkspaceAccess({
		toolName: 'Read',
		toolInput: { file_path: 'escape/secret.txt' },
		workspaceRoot: ws,
		bashPolicy: 'sandboxed',
	}).verdict
	expect(verdict).toBe('allow')
})

test('reading or writing through a link that leaves the workspace is caught', async () => {
	expect(await realPathEscape('Read', { file_path: 'escape/secret.txt' }, ws)).not.toBeNull()
	// A file that does not exist yet, under the link: its existing ancestor is resolved.
	expect(await realPathEscape('Write', { file_path: 'escape/new/job', content: 'x' }, ws)).not.toBeNull()
	expect(await realPathEscape('Glob', { path: 'escape', pattern: '*' }, ws)).not.toBeNull()
	// Our own file movers resolve inside the same workspace and follow links just the same.
	expect(await realPathEscape('move_file', { fromPath: 'src/a.ts', toPath: 'escape/a.ts' }, ws)).not.toBeNull()
})

test('ordinary paths, links that stay inside, and paths that do not exist yet are fine', async () => {
	expect(await realPathEscape('Read', { file_path: 'src/a.ts' }, ws)).toBeNull()
	expect(await realPathEscape('Read', { file_path: join(ws, 'src', 'a.ts') }, ws)).toBeNull()
	expect(await realPathEscape('Read', { file_path: 'alias/a.ts' }, ws)).toBeNull()
	expect(await realPathEscape('Write', { file_path: 'brand/new/dir/file.md', content: 'x' }, ws)).toBeNull()
	// No path argument, nothing to follow.
	expect(await realPathEscape('Glob', { pattern: '**/*' }, ws)).toBeNull()
	expect(await realPathEscape('Bash', { command: 'cat escape/secret.txt' }, ws)).toBeNull()
})

test('realLocation re-attaches the part of the path that does not exist', async () => {
	const real = await realLocation(join(ws, 'escape', 'not', 'yet'))
	expect(real.toLowerCase()).toBe(join(await realLocation(outside), 'not', 'yet').toLowerCase())
})
