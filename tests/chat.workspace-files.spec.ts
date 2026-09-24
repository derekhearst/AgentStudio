import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
	clearWorkspaceFileIndex,
	getWorkspaceFileIndex,
	INDEX_TTL_MS,
	listWorkspaceFiles,
} from '../src/lib/chat-console/workspace-files.server'
import { searchConversationFiles } from '../src/lib/chat-console/mentions.server'
import { getProjectPath } from '../src/lib/projects/project-fs.server'
import { resolveWorkspaceRoot, workspaceCarriesOver, workspaceKind } from '../src/lib/workspace/workspace.server'
import {
	cleanupExtendedPrefix,
	getActiveUserId,
	getBuiltinChatAgentId,
	getSql,
	seedAgent,
	seedProject,
	uniquePrefix,
} from './helpers'

/**
 * #22 — what `@` can list, and from where.
 *
 * The walk runs over a tree the agent can write to, so the containment half matters as much
 * as the listing: links are never followed, the heavy folders are skipped, the cost is
 * capped, and only relative `/`-separated names come back. The search is scoped to the
 * caller's own conversation and to a directory the next turn will actually run in.
 */

let base = ''

function link(target: string, path: string) {
	try {
		symlinkSync(target, path, 'dir')
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (process.platform === 'win32' && code === 'EPERM') return symlinkSync(target, path, 'junction')
		if (code === 'EPERM') test.skip(true, 'this host cannot create symlinks')
		throw error
	}
}

function touch(root: string, relative: string, body = 'x') {
	const full = join(root, ...relative.split('/'))
	mkdirSync(join(full, '..'), { recursive: true })
	writeFileSync(full, body)
}

test.describe('workspace files — the walk', () => {
	test.beforeEach(() => {
		base = resolve(tmpdir(), `agentstudio-mentions-${randomUUID()}`)
		mkdirSync(base, { recursive: true })
		clearWorkspaceFileIndex()
	})
	test.afterEach(() => rmSync(base, { recursive: true, force: true }))

	test('lists files and folders as relative, /-separated paths, shallow ones first', async () => {
		const root = join(base, 'ws')
		touch(root, 'README.md')
		touch(root, 'src/lib/app.ts')
		touch(root, 'src/index.ts')

		const index = await listWorkspaceFiles(root)
		expect(index.truncated).toBe(false)
		expect(index.entries).toEqual(['README.md', 'src/', 'src/index.ts', 'src/lib/', 'src/lib/app.ts'])
		// Never an absolute path or a backslash, on any platform.
		for (const entry of index.entries) {
			expect(entry.includes('\\')).toBe(false)
			expect(entry.startsWith('/')).toBe(false)
			expect(entry.includes(base)).toBe(false)
		}
	})

	test('skips .git and node_modules, keeps other dot-folders such as project knowledge', async () => {
		const root = join(base, 'ws')
		touch(root, '.git/config', '[core]\n\tfsmonitor = evil')
		touch(root, 'node_modules/pkg/index.js')
		touch(root, 'build/out.js')
		touch(root, '.agentstudio/knowledge/spec.md')
		touch(root, '.github/workflows/ci.yml')
		touch(root, 'app.ts')

		const { entries } = await listWorkspaceFiles(root)
		expect(entries).toContain('.agentstudio/knowledge/spec.md')
		expect(entries).toContain('.github/workflows/ci.yml')
		expect(entries).toContain('app.ts')
		expect(entries.some((e) => e.startsWith('.git/'))).toBe(false)
		expect(entries.some((e) => e.startsWith('node_modules'))).toBe(false)
		expect(entries.some((e) => e.startsWith('build'))).toBe(false)
	})

	test('a link out of the workspace is neither listed nor walked', async () => {
		const root = join(base, 'ws')
		const outside = join(base, 'host')
		touch(outside, 'environ', 'SESSION_SECRET=do-not-leak')
		touch(outside, 'nested/deep.txt')
		touch(root, 'mine.txt')
		link(outside, join(root, 'escape'))

		const { entries } = await listWorkspaceFiles(root)
		expect(entries).toEqual(['mine.txt'])
	})

	test('limits cut the walk short and say so', async () => {
		const root = join(base, 'ws')
		for (let i = 0; i < 30; i++) touch(root, `f${String(i).padStart(2, '0')}.txt`)
		touch(root, 'a/b/c/d/e.txt')

		const capped = await listWorkspaceFiles(root, { maxEntries: 10 })
		expect(capped.entries).toHaveLength(10)
		expect(capped.truncated).toBe(true)

		const shallow = await listWorkspaceFiles(root, { maxDepth: 2 })
		expect(shallow.entries).toContain('a/b/')
		expect(shallow.entries).not.toContain('a/b/c/')
		expect(shallow.truncated).toBe(true)
	})

	test('a missing root throws, which the search turns into an empty list', async () => {
		await expect(listWorkspaceFiles(join(base, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
	})

	test('the listing is cached per root for a few seconds, and walked once for concurrent callers', async () => {
		const root = join(base, 'ws')
		touch(root, 'one.txt')
		let clock = 1_000_000
		const now = () => clock

		const [a, b] = await Promise.all([getWorkspaceFileIndex(root, { now }), getWorkspaceFileIndex(root, { now })])
		expect(a).toBe(b)
		expect(a.entries).toEqual(['one.txt'])

		// A new file inside the TTL is not seen: the cached listing is reused.
		touch(root, 'two.txt')
		clock += INDEX_TTL_MS - 1
		expect(await getWorkspaceFileIndex(root, { now })).toBe(a)

		// After it, the tree is walked again.
		clock += 2
		const fresh = await getWorkspaceFileIndex(root, { now })
		expect(fresh).not.toBe(a)
		expect(fresh.entries).toEqual(['one.txt', 'two.txt'])
	})
})

test.describe('workspace kind — which directory a turn runs in', () => {
	test('one priority order, and only project and persistent directories carry over', () => {
		expect(workspaceKind({ persistentKey: 'k', worktree: { repoPath: '/r' }, runId: 'r', projectId: 'p' })).toBe('persistent')
		expect(workspaceKind({ worktree: { repoPath: '/r' }, runId: 'r', projectId: 'p' })).toBe('worktree')
		expect(workspaceKind({ worktree: { repoPath: '/r' }, projectId: 'p' })).toBe('project')
		expect(workspaceKind({ runId: 'r' })).toBe('run')
		expect(workspaceKind({})).toBe('user')
		expect(['persistent', 'project'].every((k) => workspaceCarriesOver(k as never))).toBe(true)
		expect(['worktree', 'run', 'user'].some((k) => workspaceCarriesOver(k as never))).toBe(false)
	})
})

test.describe('searchConversationFiles — scoped to the caller and to the next turn', () => {
	async function seedConversationRow(prefix: string, userId: string, fields: { projectId?: string; agentId?: string }) {
		const sql = getSql()
		const agentId = fields.agentId ?? (await getBuiltinChatAgentId())
		const [row] = await sql<{ id: string }[]>`
			insert into conversations (user_id, agent_id, project_id, title, model, total_tokens, total_cost)
			values (${userId}, ${agentId}, ${fields.projectId ?? null}, ${`${prefix} convo`}, 'anthropic/claude-sonnet-4', 0, '0')
			returning id
		`
		return row.id
	}

	test("a project-bound chat searches the project's checkout", async () => {
		const prefix = uniquePrefix('mentions-project')
		const userId = await getActiveUserId()
		let projectPath = ''
		try {
			const project = await seedProject(prefix)
			projectPath = getProjectPath(userId, project.id)
			await mkdir(join(projectPath, 'docs'), { recursive: true })
			await writeFile(join(projectPath, 'docs', 'pinned-notes.md'), '# notes')
			await writeFile(join(projectPath, 'main.ts'), 'export {}')
			const conversationId = await seedConversationRow(prefix, userId, { projectId: project.id })

			const result = await searchConversationFiles({ conversationId, userId, query: 'pin' })
			expect(result.ok).toBe(true)
			if (!result.ok) return
			expect(result.results[0]).toMatchObject({ path: 'docs/pinned-notes.md', isDirectory: false })
			expect(result.results[0].indices.length).toBe(3)

			const top = await searchConversationFiles({ conversationId, userId, query: '' })
			expect(top.ok && top.results.map((r) => r.path)).toEqual(['docs/', 'main.ts', 'docs/pinned-notes.md'])
		} finally {
			if (projectPath) await rm(projectPath, { recursive: true, force: true }).catch(() => {})
			await cleanupExtendedPrefix(prefix)
		}
	})

	test("someone else's conversation is answered like a missing one", async () => {
		const prefix = uniquePrefix('mentions-foreign')
		const userId = await getActiveUserId()
		try {
			const project = await seedProject(prefix)
			const conversationId = await seedConversationRow(prefix, userId, { projectId: project.id })
			const stranger = randomUUID()
			expect(await searchConversationFiles({ conversationId, userId: stranger, query: '' })).toMatchObject({
				ok: false,
				reason: 'not-found',
			})
			expect(await searchConversationFiles({ conversationId: randomUUID(), userId, query: '' })).toMatchObject({
				ok: false,
				reason: 'not-found',
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})

	test('a chat whose every turn starts in a fresh folder has nothing to mention, and says why', async () => {
		const prefix = uniquePrefix('mentions-unbound')
		const userId = await getActiveUserId()
		try {
			const conversationId = await seedConversationRow(prefix, userId, {})
			const result = await searchConversationFiles({ conversationId, userId, query: '' })
			expect(result).toMatchObject({ ok: false, reason: 'no-workspace' })
			expect(!result.ok && result.message).toMatch(/Bind the chat to a project/)
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})

	test("an unbound chat with a persistent-workspace agent searches that workspace", async () => {
		const prefix = uniquePrefix('mentions-persistent')
		const userId = await getActiveUserId()
		const key = `mentions-${randomUUID().slice(0, 8)}`
		const root = resolveWorkspaceRoot({ userId, persistentKey: key, sandboxRoot: process.env.SANDBOX_WORKSPACE })
		try {
			const agent = await seedAgent(prefix)
			await getSql()`update agents set config = ${getSql().json({ workspace: { mode: 'persistent', key } })} where id = ${agent.id}`
			await mkdir(root, { recursive: true })
			await writeFile(join(root, 'kept.txt'), 'still here next turn')
			const conversationId = await seedConversationRow(prefix, userId, { agentId: agent.id })

			const result = await searchConversationFiles({ conversationId, userId, query: 'kept' })
			expect(result.ok && result.results.map((r) => r.path)).toEqual(['kept.txt'])
		} finally {
			await rm(root, { recursive: true, force: true }).catch(() => {})
			await cleanupExtendedPrefix(prefix)
		}
	})

	test('a project whose directory is not there yet has no files, which is not an error', async () => {
		const prefix = uniquePrefix('mentions-nodir')
		const userId = await getActiveUserId()
		try {
			const project = await seedProject(prefix)
			const conversationId = await seedConversationRow(prefix, userId, { projectId: project.id })
			expect(await searchConversationFiles({ conversationId, userId, query: 'x' })).toEqual({
				ok: true,
				results: [],
				truncated: false,
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})

	test('an oversized or NUL-carrying query is refused before anything is read', async () => {
		const userId = await getActiveUserId()
		expect(await searchConversationFiles({ conversationId: randomUUID(), userId, query: 'a\0b' })).toMatchObject({
			ok: false,
			reason: 'invalid',
		})
		expect(await searchConversationFiles({ conversationId: randomUUID(), userId, query: 'a'.repeat(201) })).toMatchObject({
			ok: false,
			reason: 'invalid',
		})
	})
})
