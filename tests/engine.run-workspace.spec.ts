import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { createAttachmentIo } from '../src/lib/engine/attachment-io.server'
import { guardWorkspaceAccess } from '../src/lib/engine/workspace-guard'
import { resolveSettingSources } from '../src/lib/engine/setting-sources'
import {
	prepareRunWorkspace,
	resolveRunWorkspace,
	resolveWorkspaceRoot,
} from '../src/lib/workspace/workspace.server'

/**
 * One run, one workspace root.
 *
 * The chat route computed the containment guard's root inline with no `sandboxRoot`, so it
 * fell back to `/workspace/users` while the tools, attachment staging and project checkouts
 * all used `SANDBOX_WORKSPACE` (`/workspace` in the image). In production the guard fenced a
 * directory nothing used — every built-in file call into the real workspace was refused —
 * and the SDK was never given a cwd at all, so relative paths meant one directory to the
 * guard and the app's own install directory to the tool.
 *
 * `resolveRunWorkspace` is now the one computation the route makes, and the guard root, the
 * SDK's cwd and attachment staging all take it from there.
 */

const IDS = { userId: 'u1', runId: 'r1', persistentKey: null, worktree: null }

test.describe('resolveRunWorkspace', () => {
	test('uses the configured SANDBOX_WORKSPACE, which the tools resolve with too', () => {
		const previous = process.env.SANDBOX_WORKSPACE
		process.env.SANDBOX_WORKSPACE = resolve('/srv/sandbox-test')
		try {
			const ws = resolveRunWorkspace({ ...IDS, projectId: null })
			// Exactly what `getWorkspace()` computes for the run's in-house tools.
			expect(ws.root).toBe(resolveWorkspaceRoot({ ...IDS, projectId: null, sandboxRoot: resolve('/srv/sandbox-test') }))
			expect(ws.root.startsWith(resolve('/srv/sandbox-test'))).toBe(true)
			// Not the fallback the route's inline call used to land on.
			expect(ws.root.startsWith(resolve('/workspace/users'))).toBe(false)
			expect(ws.context.sandboxRoot).toBe(resolve('/srv/sandbox-test'))
		} finally {
			if (previous === undefined) delete process.env.SANDBOX_WORKSPACE
			else process.env.SANDBOX_WORKSPACE = previous
		}
	})

	test("knows when it is standing in the project's own checkout", () => {
		const root = resolve('/srv/sb')
		expect(resolveRunWorkspace({ ...IDS, projectId: 'p1' }, root).projectCheckout).toBe(true)
		// An agent's persistent or worktree directory wins over the project path — and is not
		// the checkout the operator trusted.
		expect(resolveRunWorkspace({ ...IDS, projectId: 'p1', persistentKey: 'k' }, root).projectCheckout).toBe(false)
		expect(
			resolveRunWorkspace({ ...IDS, projectId: 'p1', worktree: { repoPath: '/repo' } }, root).projectCheckout,
		).toBe(false)
		expect(resolveRunWorkspace({ ...IDS, projectId: null }, root).projectCheckout).toBe(false)
	})

	test("a trusted project's configuration loads once the run has its cwd", () => {
		// With no cwd the trust flag could never take effect; the route now always has one.
		const ws = resolveRunWorkspace({ ...IDS, projectId: 'p1' }, resolve('/srv/sb'))
		expect(resolveSettingSources({ settingsTrusted: ws.projectCheckout, hasWorkspace: Boolean(ws.root) })).toEqual([
			'project',
		])
		expect(resolveSettingSources({ settingsTrusted: false, hasWorkspace: Boolean(ws.root) })).toEqual([])
	})
})

test.describe('the guard, the cwd and attachment staging agree', () => {
	test('a staged attachment is readable through the guard by the path the model is given', async () => {
		const sandboxRoot = await mkdtemp(resolve(tmpdir(), 'agentstudio-runws-'))
		try {
			const ws = await prepareRunWorkspace({ ...IDS, projectId: null, sandboxRoot })
			// Created up front: the SDK will not spawn in a directory that does not exist.
			expect((await stat(ws.root)).isDirectory()).toBe(true)

			const io = createAttachmentIo(ws.context)
			const staged = await io.stage!(
				{ id: 'abcd1234-0000', filename: 'notes.txt', mimeType: 'text/plain', size: 5, url: '/api/upload/x.txt' },
				Buffer.from('hello'),
			)
			expect(staged).not.toBeNull()
			const relative = staged!
			expect(await readFile(resolve(ws.root, relative), 'utf8')).toBe('hello')

			// The route hands the guard and the SDK the same `ws.root`. Relative (as announced)
			// and absolute both resolve inside it.
			for (const file_path of [relative, resolve(ws.root, relative)]) {
				const verdict = guardWorkspaceAccess({
					toolName: 'Read',
					toolInput: { file_path },
					workspaceRoot: ws.root,
					bashPolicy: 'sandboxed',
				}).verdict
				expect(verdict, file_path).toBe('allow')
			}
		} finally {
			await rm(sandboxRoot, { recursive: true, force: true })
		}
	})
})
