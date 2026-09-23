import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
	buildPreviewPayload,
	PreviewError,
	readRawBytes,
	resolvePreviewPath,
	type ConversationWorkspace,
} from '../src/lib/chat-console/preview.server'

/**
 * #29 — the rail preview reads files with the server's privileges and hands the bytes to
 * the browser, so its containment is what stands between a workspace symlink and the
 * server's environment or another user's projects. The docs promise there is no way to ask
 * it for an arbitrary file on the server; these specs hold it to that with real links.
 */

let base = ''
let workspace: ConversationWorkspace
let outside = ''

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

async function statusOf(promise: Promise<unknown>): Promise<number | 'ok'> {
	try {
		await promise
		return 'ok'
	} catch (error) {
		if (error instanceof PreviewError) return error.status
		throw error
	}
}

/**
 * A relative path is tried against the run workspace and then the user root, so a link
 * that escapes from the first can come back as "not found" from the second. Either is a
 * refusal; what matters is that nothing was read.
 */
const REFUSED = [403, 404]

test.beforeEach(() => {
	base = resolve(tmpdir(), `agentstudio-preview-${randomUUID()}`)
	const containmentRoot = join(base, 'users', 'u-a')
	const defaultRoot = join(containmentRoot, 'runs', 'r1')
	outside = join(base, 'host')
	mkdirSync(defaultRoot, { recursive: true })
	mkdirSync(join(containmentRoot, 'projects', 'p1'), { recursive: true })
	mkdirSync(join(base, 'users', 'u-b', 'projects', 'p9'), { recursive: true })
	mkdirSync(outside, { recursive: true })
	writeFileSync(join(outside, 'environ'), 'SESSION_SECRET=do-not-leak')
	writeFileSync(join(outside, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
	writeFileSync(join(base, 'users', 'u-b', 'projects', 'p9', 'notes.md'), 'user B only')
	writeFileSync(join(defaultRoot, 'README.md'), '# mine')
	writeFileSync(join(containmentRoot, 'projects', 'p1', 'plan.md'), '# plan')
	workspace = { containmentRoot, defaultRoot }
})

test.afterEach(() => {
	rmSync(base, { recursive: true, force: true })
})

test.describe('chat-console/preview — symlinks cannot widen what the rail will read', () => {
	test('a directory link to the host is refused', async () => {
		link(outside, join(workspace.defaultRoot, 'root'), 'dir')
		// Absolute: one candidate, and it escapes.
		expect(await statusOf(resolvePreviewPath(workspace, join(workspace.defaultRoot, 'root', 'environ')))).toBe(403)
		expect(REFUSED).toContain(await statusOf(buildPreviewPayload(workspace, 'root/environ', (p) => p)))
		expect(REFUSED).toContain(await statusOf(buildPreviewPayload(workspace, 'root', (p) => p)))
	})

	test('a file link to the host is refused, as text and as raw bytes', async () => {
		link(join(outside, 'environ'), join(workspace.defaultRoot, 'env.txt'), 'file')
		link(join(outside, 'shot.png'), join(workspace.defaultRoot, 'shot.png'), 'file')
		expect(REFUSED).toContain(await statusOf(buildPreviewPayload(workspace, 'env.txt', (p) => p)))
		expect(REFUSED).toContain(await statusOf(readRawBytes(workspace, 'shot.png')))
		expect(await statusOf(readRawBytes(workspace, join(workspace.defaultRoot, 'shot.png')))).toBe(403)
	})

	test("a link into another user's workspace is refused", async () => {
		link(join(base, 'users', 'u-b'), join(workspace.defaultRoot, 'other'), 'dir')
		expect(REFUSED).toContain(await statusOf(buildPreviewPayload(workspace, 'other/projects/p9/notes.md', (p) => p)))
	})

	test("a directory listing leaves links out, and the user's own files still preview", async () => {
		link(outside, join(workspace.defaultRoot, 'root'), 'dir')
		const listing = await buildPreviewPayload(workspace, '.', (p) => p)
		expect(listing.kind).toBe('directory')
		if (listing.kind !== 'directory') return
		expect(listing.entries.map((e) => e.name)).toEqual(['README.md'])

		const file = await buildPreviewPayload(workspace, 'README.md', (p) => p)
		expect(file.kind).toBe('markdown')
	})

	test("a link that stays inside the user's own tree still previews", async () => {
		link(join(workspace.containmentRoot, 'projects', 'p1'), join(workspace.defaultRoot, 'project'), 'dir')
		const file = await buildPreviewPayload(workspace, 'project/plan.md', (p) => p)
		expect(file.kind).toBe('markdown')
		if (file.kind === 'markdown') expect(file.content).toBe('# plan')
	})
})
