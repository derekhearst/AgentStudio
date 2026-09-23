import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { safePathWithin } from '../src/lib/workspace/workspace.server'
import { isRealPathWithin, resolveRealPath } from '../src/lib/workspace/containment.server'
import { guardWorkspaceAccess } from '../src/lib/engine/workspace-guard'

/**
 * Containment has to hold on the path the OS really opens, not just the one that was typed.
 *
 * A symlink inside a workspace can point anywhere — sandboxed Bash may create one in its own
 * cwd, and an imported repo can commit one — and every server-side reader follows it. These
 * specs build real links on disk. Each refusal is paired with an allowance, because a
 * containment check that refuses everything passes a refusal-only suite just as well.
 */

type Layout = { base: string; ws: string; outside: string; sibling: string }

function makeLayout(): Layout {
	const base = resolve(tmpdir(), `agentstudio-symlink-${randomUUID()}`)
	const ws = join(base, 'users', 'u-a', 'runs', 'r1')
	const outside = join(base, 'host')
	const sibling = join(base, 'users', 'u-b')
	for (const dir of [ws, outside, join(sibling, 'projects', 'p1'), join(ws, 'src')]) mkdirSync(dir, { recursive: true })
	writeFileSync(join(outside, 'secret.env'), 'DATABASE_URL=postgres://prod')
	writeFileSync(join(sibling, 'projects', 'p1', 'notes.md'), 'user B only')
	writeFileSync(join(ws, 'src', 'index.ts'), 'export {}')
	return { base, ws, outside, sibling }
}

/**
 * Create a symlink, or skip the test where the host refuses to (Windows without developer
 * mode). A directory falls back to a junction, which Windows allows unprivileged.
 */
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

let layout: Layout
test.beforeEach(() => {
	layout = makeLayout()
})
test.afterEach(() => {
	rmSync(layout.base, { recursive: true, force: true })
})

test.describe('workspace/containment — safePathWithin follows symlinks before deciding', () => {
	test('a directory link pointing out of the workspace is refused, for reads and creates alike', () => {
		const { ws, outside } = layout
		link(outside, join(ws, 'root'), 'dir')

		expect(() => safePathWithin(ws, 'root/secret.env')).toThrow(/Path escapes sandbox workspace/)
		// A file that does not exist yet is judged by where it would be created.
		expect(() => safePathWithin(ws, 'root/new-file.txt')).toThrow(/Path escapes sandbox workspace/)
		expect(() => safePathWithin(ws, 'root/deep/new/dir')).toThrow(/Path escapes sandbox workspace/)
		expect(() => safePathWithin(ws, 'root')).toThrow(/Path escapes sandbox workspace/)
	})

	test("a link into another user's tree is refused", () => {
		const { ws, sibling } = layout
		link(sibling, join(ws, 'x'), 'dir')
		expect(() => safePathWithin(ws, 'x/projects')).toThrow(/Path escapes sandbox workspace/)
		expect(() => safePathWithin(ws, 'x/projects/p1/notes.md')).toThrow(/Path escapes sandbox workspace/)
	})

	test('a file link pointing out is refused', () => {
		const { ws, outside } = layout
		link(join(outside, 'secret.env'), join(ws, 'env.txt'), 'file')
		expect(() => safePathWithin(ws, 'env.txt')).toThrow(/Path escapes sandbox workspace/)
	})

	test('a dangling link is judged by where a write through it would land', () => {
		const { ws, outside } = layout
		link(join(outside, 'planted.sh'), join(ws, 'dangling'), 'file')
		expect(() => safePathWithin(ws, 'dangling')).toThrow(/Path escapes sandbox workspace/)

		link(join(ws, 'src', 'later.ts'), join(ws, 'dangling-inside'), 'file')
		expect(safePathWithin(ws, 'dangling-inside')).toBe(join(ws, 'dangling-inside'))
	})

	test('links that stay inside the workspace keep working, and the lexical path is returned', () => {
		const { ws } = layout
		link(join(ws, 'src'), join(ws, 'alias'), 'dir')
		expect(safePathWithin(ws, 'alias/index.ts')).toBe(join(ws, 'alias', 'index.ts'))
		expect(safePathWithin(ws, 'alias/not-yet.ts')).toBe(join(ws, 'alias', 'not-yet.ts'))
		expect(safePathWithin(ws, 'src/index.ts')).toBe(join(ws, 'src', 'index.ts'))
		expect(safePathWithin(ws, 'brand/new/file.md')).toBe(join(ws, 'brand', 'new', 'file.md'))
	})

	test('a workspace that is itself reached through a link still contains its own files', () => {
		const { base, ws } = layout
		const via = join(base, 'via')
		link(ws, via, 'dir')
		expect(safePathWithin(via, 'src/index.ts')).toBe(join(via, 'src', 'index.ts'))
		expect(() => safePathWithin(via, '../escape')).toThrow(/Path escapes sandbox workspace/)
	})

	test('the lexical checks still hold', () => {
		const { ws } = layout
		expect(() => safePathWithin(ws, '../../u-b/projects')).toThrow(/Path escapes sandbox workspace/)
		expect(() => safePathWithin(ws, `${ws}-evil/x`)).toThrow(/Path escapes sandbox workspace/)
	})

	test('a link loop is refused rather than followed forever', () => {
		const { ws } = layout
		link(join(ws, 'loop-b'), join(ws, 'loop-a'), 'file')
		link(join(ws, 'loop-a'), join(ws, 'loop-b'), 'file')
		expect(() => safePathWithin(ws, 'loop-a')).toThrow(/Path escapes sandbox workspace/)
	})
})

test.describe('workspace/containment — resolveRealPath', () => {
	test('resolves the nearest existing ancestor for a path that does not exist', () => {
		const { ws, outside } = layout
		link(outside, join(ws, 'root'), 'dir')
		expect(resolveRealPath(join(ws, 'root', 'a', 'b.txt'))).toBe(join(resolveRealPath(outside), 'a', 'b.txt'))
		expect(isRealPathWithin(ws, join(ws, 'root', 'a'))).toBe(false)
		expect(isRealPathWithin(ws, join(ws, 'src', 'a'))).toBe(true)
	})
})

/**
 * `..` straight after a link. Linux and macOS follow the link first and then take `..`
 * from wherever it really led; `path.resolve` (and Windows) collapse it in the string.
 * So `s/../x` with `s -> <elsewhere>/dir` is `<workspace>/x` on paper and `<elsewhere>/x`
 * to the kernel, and a dangling link spelled that way was a create-anywhere primitive on
 * the POSIX hosts production runs on. A spelling whose two readings differ is refused on
 * every host; one whose readings agree keeps working.
 */
test.describe('workspace/containment — `..` after a link is judged the way the kernel reads it', () => {
	/** Another user's git hooks: the kind of not-yet-existing file an attacker wants to plant. */
	function hooksOfOtherUser() {
		const hooks = join(layout.sibling, 'projects', 'p1', '.git', 'hooks')
		mkdirSync(hooks, { recursive: true })
		return hooks
	}

	test("a dangling link spelled `s/../x`, where `s` leads out, cannot plant a file in another user's tree", () => {
		const { ws } = layout
		link(hooksOfOtherUser(), join(ws, 's'), 'dir')
		// The kernel creates this at <sibling>/projects/p1/.git/pre-commit; the string says <ws>/pre-commit.
		link('s/../pre-commit', join(ws, 'L'), 'file')

		expect(() => safePathWithin(ws, 'L')).toThrow(/Path escapes sandbox workspace/)
		expect(() => resolveRealPath(join(ws, 'L'))).toThrow(/different things depending on how ".." is resolved/)
		const g = (toolName: string, toolInput: unknown) =>
			guardWorkspaceAccess({ toolName, toolInput, workspaceRoot: ws, bashPolicy: 'sandboxed' }).verdict
		expect(g('Write', { file_path: 'L', content: '#!/bin/sh' })).toBe('deny')
		expect(g('Write', { file_path: join(ws, 'L'), content: '#!/bin/sh' })).toBe('deny')
	})

	test('the mirror case, a `..` that only Windows would collapse out of the workspace, is refused too', () => {
		const { ws } = layout
		const deep = join(ws, 'src', 'deep', 'er')
		mkdirSync(deep, { recursive: true })
		link(deep, join(ws, 'in'), 'dir')
		// Kernel: <ws>/src/x. Windows: <ws>/../x, outside.
		link('in/../../x', join(ws, 'W'), 'file')
		expect(() => safePathWithin(ws, 'W')).toThrow(/Path escapes sandbox workspace/)
	})

	test('`..` in a link target that does not follow a link still works', () => {
		const { ws } = layout
		mkdirSync(join(ws, 'd'))
		link('d/../src/later.ts', join(ws, 'M'), 'file')
		// Leaves the workspace in the string and comes straight back: both readings agree.
		link('../r1/src/later.ts', join(ws, 'N'), 'file')
		expect(safePathWithin(ws, 'M')).toBe(join(ws, 'M'))
		expect(safePathWithin(ws, 'N')).toBe(join(ws, 'N'))
		expect(resolveRealPath(join(ws, 'M'))).toBe(join(resolveRealPath(ws), 'src', 'later.ts'))
	})

	test('a raw path argument is resolved as written, not as `path.resolve` tidies it', () => {
		const { ws, outside } = layout
		mkdirSync(join(outside, 'dir'))
		link(join(outside, 'dir'), join(ws, 's'), 'dir')
		link(join(ws, 'src'), join(ws, 'alias'), 'dir')
		const g = (toolName: string, toolInput: unknown) =>
			guardWorkspaceAccess({ toolName, toolInput, workspaceRoot: ws, bashPolicy: 'sandboxed' }).verdict

		// Normalised, this is <ws>/x. Opened as written on Linux, it is <outside>/x.
		expect(g('Write', { file_path: 's/../x', content: 'x' })).toBe('deny')
		expect(g('Write', { file_path: `${ws}${sep}s${sep}..${sep}x`, content: 'x' })).toBe('deny')
		expect(() => resolveRealPath(`${ws}${sep}s${sep}..${sep}x`)).toThrow(/different things/)

		// `alias` is <ws>/src, whose parent is the workspace either way.
		expect(g('Write', { file_path: 'alias/../new.ts', content: 'x' })).toBe('allow')
		expect(g('Read', { file_path: 'src/../src/index.ts' })).toBe('allow')
		// A folder that does not exist yet, then `..`: where mkdir -p then open would land.
		expect(resolveRealPath(`${ws}${sep}missing${sep}..${sep}src${sep}index.ts`)).toBe(
			join(resolveRealPath(ws), 'src', 'index.ts'),
		)
	})

	test('a chain of links that each double back is refused quickly instead of fanning out', () => {
		const { ws } = layout
		mkdirSync(join(ws, 'c0'))
		// Each link names the previous one twice. Resolved naively that is 2^n walks.
		for (let i = 1; i <= 24; i++) link(`c${i - 1}/../c${i - 1}`, join(ws, `c${i}`), 'dir')
		const started = Date.now()
		expect(() => safePathWithin(ws, 'c24/new.txt')).toThrow(/Path escapes sandbox workspace/)
		expect(Date.now() - started).toBeLessThan(2_000)
		// A short chain of the same shape is fine.
		expect(safePathWithin(ws, 'c2/new.txt')).toBe(join(ws, 'c2', 'new.txt'))
	})
})

test.describe('engine/workspace-guard — the SDK built-ins get the same rule', () => {
	test('Read/Write through a link out of the workspace are denied; inside ones are allowed', () => {
		const { ws, outside } = layout
		link(outside, join(ws, 'root'), 'dir')
		link(join(ws, 'src'), join(ws, 'alias'), 'dir')
		const g = (toolName: string, toolInput: unknown) =>
			guardWorkspaceAccess({ toolName, toolInput, workspaceRoot: ws, bashPolicy: 'sandboxed' }).verdict

		expect(g('Read', { file_path: 'root/secret.env' })).toBe('deny')
		expect(g('Read', { file_path: join(ws, 'root', 'secret.env') })).toBe('deny')
		expect(g('Write', { file_path: 'root/planted.sh', content: 'x' })).toBe('deny')
		// Folders that do not exist yet under the link: the existing part is what gets followed.
		expect(g('Write', { file_path: 'root/cron.d/new/job', content: 'x' })).toBe('deny')
		expect(g('Grep', { path: 'root', pattern: 'DATABASE' })).toBe('deny')
		expect(g('Glob', { path: 'root', pattern: '*' })).toBe('deny')

		expect(g('Read', { file_path: 'alias/index.ts' })).toBe('allow')
		expect(g('Read', { file_path: join(ws, 'src', 'index.ts') })).toBe('allow')
		expect(g('Write', { file_path: 'src/new.ts', content: 'x' })).toBe('allow')
		expect(g('Write', { file_path: 'brand/new/dir/file.md', content: 'x' })).toBe('allow')
		// No path argument, nothing to follow; a sandboxed shell is the OS's to confine.
		expect(g('Glob', { pattern: '**/*' })).toBe('allow')
		expect(g('Bash', { command: 'cat root/secret.env' })).toBe('allow')
	})

	test('an injected resolver decides without the disk, and a resolver error denies', () => {
		const WS = process.platform === 'win32' ? 'C:\\sandbox\\user-aaa' : '/sandbox/user-aaa'
		const HOST = process.platform === 'win32' ? 'C:\\etc' : '/etc'
		const resolveRealPath = (p: string) => (p.includes('escape-link') ? HOST : p)
		const decide = (file_path: string, resolver = resolveRealPath) =>
			guardWorkspaceAccess({
				toolName: 'Read',
				toolInput: { file_path },
				workspaceRoot: WS,
				bashPolicy: 'sandboxed',
				resolveRealPath: resolver,
			}).verdict

		expect(decide('escape-link')).toBe('deny')
		expect(decide('ordinary.txt')).toBe('allow')
		expect(
			decide('ordinary.txt', () => {
				throw Object.assign(new Error('loop'), { code: 'ELOOP' })
			}),
		).toBe('deny')
	})
})
