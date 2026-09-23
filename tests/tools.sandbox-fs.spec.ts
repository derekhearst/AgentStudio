import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { toolUserContext } from '../src/lib/tools/sandbox.server'
import { fileList, fileMove, fileRead, fileWrite } from '../src/lib/tools/sandbox-fs.server'
import { resolveWorkspaceRoot } from '../src/lib/workspace/workspace.server'

/**
 * The in-house file tools run in the server process, unconfined by any OS sandbox, so the
 * only thing between them and the host is `safePath` plus their own care. These specs drive
 * them against a real temporary sandbox root.
 */

const USER = 'u-sandboxfs'
let sandboxRoot = ''
let ws = ''
let previousRoot: string | undefined

function inWorkspace<T>(fn: () => Promise<T>): Promise<T> {
	return toolUserContext.run({ userId: USER, runId: 'r1' }, fn)
}

function link(target: string, path: string, kind: 'dir' | 'file') {
	try {
		symlinkSync(target, path, kind)
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (process.platform === 'win32' && code === 'EPERM' && kind === 'dir') {
			symlinkSync(target, path, 'junction')
			return
		}
		if (code === 'EPERM') test.skip(true, 'this host cannot create symlinks')
		throw error
	}
}

test.beforeEach(() => {
	previousRoot = process.env.SANDBOX_WORKSPACE
	sandboxRoot = resolve(tmpdir(), `agentstudio-sandboxfs-${randomUUID()}`)
	process.env.SANDBOX_WORKSPACE = sandboxRoot
	ws = resolveWorkspaceRoot({ userId: USER, runId: 'r1', sandboxRoot })
	mkdirSync(join(ws, 'src'), { recursive: true })
	mkdirSync(join(ws, 'docs'), { recursive: true })
	writeFileSync(join(ws, 'src', 'a.ts'), 'source a')
	writeFileSync(join(ws, 'src', 'b.ts'), 'source b')
	writeFileSync(join(ws, 'docs', 'guide.md'), 'the guide')
})

test.afterEach(() => {
	if (previousRoot === undefined) delete process.env.SANDBOX_WORKSPACE
	else process.env.SANDBOX_WORKSPACE = previousRoot
	rmSync(sandboxRoot, { recursive: true, force: true })
})

test.describe('tools/sandbox-fs — move_file never destroys the target before the move succeeds', () => {
	test('a missing source leaves an overwrite target untouched', async () => {
		await expect(inWorkspace(() => fileMove('typo.txt', 'docs', true))).rejects.toThrow(/Source does not exist/)
		expect(readFileSync(join(ws, 'docs', 'guide.md'), 'utf-8')).toBe('the guide')
	})

	test('moving a file onto the directory that contains it is refused, and the directory survives', async () => {
		await expect(inWorkspace(() => fileMove('src/a.ts', 'src', true))).rejects.toThrow(/Cannot replace src/)
		expect(readFileSync(join(ws, 'src', 'a.ts'), 'utf-8')).toBe('source a')
		expect(readFileSync(join(ws, 'src', 'b.ts'), 'utf-8')).toBe('source b')
	})

	test('moving a directory into itself is refused', async () => {
		await expect(inWorkspace(() => fileMove('src', 'src/nested/src', true))).rejects.toThrow(/into itself/)
		expect(existsSync(join(ws, 'src', 'a.ts'))).toBe(true)
	})

	test('a path moved onto itself is refused instead of deleted', async () => {
		await expect(inWorkspace(() => fileMove('src/a.ts', 'src/a.ts', true))).rejects.toThrow(/same path/)
		await expect(inWorkspace(() => fileMove('src/a.ts', './src/../src/a.ts', true))).rejects.toThrow(/same path/)
		expect(readFileSync(join(ws, 'src', 'a.ts'), 'utf-8')).toBe('source a')
	})

	test('without overwrite an existing target is refused', async () => {
		await expect(inWorkspace(() => fileMove('src/a.ts', 'src/b.ts'))).rejects.toThrow(/Target already exists/)
		expect(readFileSync(join(ws, 'src', 'b.ts'), 'utf-8')).toBe('source b')
	})

	test('overwrite replaces a file, and leaves nothing behind', async () => {
		await inWorkspace(() => fileMove('src/a.ts', 'src/b.ts', true))
		expect(readFileSync(join(ws, 'src', 'b.ts'), 'utf-8')).toBe('source a')
		expect(existsSync(join(ws, 'src', 'a.ts'))).toBe(false)
		expect(readdirSync(join(ws, 'src'))).toEqual(['b.ts'])
	})

	test('overwrite replaces a non-empty directory', async () => {
		mkdirSync(join(ws, 'next'))
		writeFileSync(join(ws, 'next', 'fresh.md'), 'fresh')
		await inWorkspace(() => fileMove('next', 'docs', true))
		expect(readdirSync(join(ws, 'docs'))).toEqual(['fresh.md'])
		expect(existsSync(join(ws, 'next'))).toBe(false)
		expect(readdirSync(ws).filter((name) => name.includes('replaced'))).toEqual([])
	})

	test('a plain move and rename still work', async () => {
		await inWorkspace(() => fileMove('src/a.ts', 'lib/deep/a.ts'))
		expect(readFileSync(join(ws, 'lib', 'deep', 'a.ts'), 'utf-8')).toBe('source a')
	})

	test('a case-only rename works on a case-insensitive disk', async () => {
		test.skip(!existsSync(join(ws, 'SRC', 'a.ts')), 'this filesystem is case-sensitive')
		await inWorkspace(() => fileMove('docs/guide.md', 'docs/GUIDE.md'))
		expect(readdirSync(join(ws, 'docs'))).toEqual(['GUIDE.md'])
	})
})

test.describe('tools/sandbox-fs — symlinks do not lead out of the workspace', () => {
	test('reading, writing and moving through a link out of the workspace are refused', async () => {
		const outside = join(sandboxRoot, 'host')
		mkdirSync(outside, { recursive: true })
		writeFileSync(join(outside, 'secret.env'), 'SESSION_SECRET=x')
		link(outside, join(ws, 'root'), 'dir')

		await expect(inWorkspace(() => fileRead('root/secret.env'))).rejects.toThrow(/escapes sandbox workspace/)
		await expect(inWorkspace(() => fileWrite('root/planted.sh', 'echo pwned'))).rejects.toThrow(
			/escapes sandbox workspace/,
		)
		await expect(inWorkspace(() => fileMove('root/secret.env', 'loot.env'))).rejects.toThrow(
			/escapes sandbox workspace/,
		)
		await expect(inWorkspace(() => fileMove('src/a.ts', 'root/a.ts'))).rejects.toThrow(/escapes sandbox workspace/)
		expect(existsSync(join(outside, 'planted.sh'))).toBe(false)
		expect(existsSync(join(outside, 'secret.env'))).toBe(true)
		expect(existsSync(join(outside, 'a.ts'))).toBe(false)
		expect(existsSync(join(ws, 'src', 'a.ts'))).toBe(true)
	})

	test('list_files shows a link but never walks into it', async () => {
		const outside = join(sandboxRoot, 'host')
		mkdirSync(join(outside, 'etc'), { recursive: true })
		writeFileSync(join(outside, 'etc', 'passwd'), 'root:x:0:0')
		link(outside, join(ws, 'root'), 'dir')

		const entries = await inWorkspace(() => fileList('.', { depth: 5 }))
		const paths = entries.map((entry) => entry.path)
		expect(paths).toContain('root')
		expect(paths).toContain('src/a.ts')
		expect(paths.some((p) => p.startsWith('root/'))).toBe(false)
	})
})
