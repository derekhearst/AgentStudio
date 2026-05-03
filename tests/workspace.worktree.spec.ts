import { execFile } from 'node:child_process'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
	buildBranchDeleteArgs,
	buildHeadBranchArgs,
	buildWorktreeAddArgs,
	buildWorktreeListArgs,
	buildWorktreeRemoveArgs,
	parseWorktreeList,
} from '../src/lib/workspace/worktree-core'
import { cleanupWorktree, ensureWorktree, listWorktrees } from '../src/lib/workspace/worktree.server'
import { ensureWorkspace, resolveWorkspaceRoot } from '../src/lib/workspace/workspace.server'
import { runWorkspaceGcCore, type LookupRuns, type RunStatusForGc } from '../src/lib/workspace/gc-core'

const exec = promisify(execFile)

async function pathExists(p: string) {
	try {
		await stat(p)
		return true
	} catch {
		return false
	}
}

async function makeTempDir(label: string) {
	const dir = resolve(tmpdir(), `agentstudio-${label}-${randomUUID()}`)
	await mkdir(dir, { recursive: true })
	return dir
}

async function git(cwd: string, ...args: string[]) {
	return exec('git', ['-C', cwd, ...args])
}

async function makeBareishRepo(label: string): Promise<string> {
	const repo = await makeTempDir(label)
	await git(repo, 'init', '-b', 'main')
	await git(repo, 'config', 'user.email', 'test@example.com')
	await git(repo, 'config', 'user.name', 'Test')
	await writeFile(resolve(repo, 'README.md'), '# repo\n')
	await git(repo, 'add', 'README.md')
	await git(repo, 'commit', '-m', 'initial')
	return repo
}

test.describe('workspace/worktree-core — pure helpers', () => {
	test('buildWorktreeAddArgs assembles the expected git argv', () => {
		const args = buildWorktreeAddArgs({
			repoPath: '/repo',
			worktreePath: '/sandbox/wt',
			branch: 'run/abc-123',
			baseBranch: 'main',
		})
		expect(args).toEqual(['-C', '/repo', 'worktree', 'add', '-b', 'run/abc-123', '/sandbox/wt', 'main'])
	})

	test('buildWorktreeAddArgs rejects unsafe branch names', () => {
		expect(() =>
			buildWorktreeAddArgs({
				repoPath: '/repo',
				worktreePath: '/sandbox/wt',
				branch: '../../etc/passwd',
			}),
		).toThrow(/Invalid branch/)
	})

	test('buildWorktreeRemoveArgs uses --force', () => {
		expect(buildWorktreeRemoveArgs({ repoPath: '/r', worktreePath: '/wt' })).toEqual([
			'-C',
			'/r',
			'worktree',
			'remove',
			'--force',
			'/wt',
		])
	})

	test('buildBranchDeleteArgs uses -D and validates branch ref', () => {
		expect(buildBranchDeleteArgs({ repoPath: '/r', branch: 'run/abc' })).toEqual([
			'-C',
			'/r',
			'branch',
			'-D',
			'run/abc',
		])
		expect(() => buildBranchDeleteArgs({ repoPath: '/r', branch: 'has space' })).toThrow(/Invalid branch/)
	})

	test('buildHeadBranchArgs and buildWorktreeListArgs', () => {
		expect(buildHeadBranchArgs('/r')).toEqual(['-C', '/r', 'symbolic-ref', '--short', 'HEAD'])
		expect(buildWorktreeListArgs('/r')).toEqual(['-C', '/r', 'worktree', 'list', '--porcelain'])
	})

	test('parseWorktreeList extracts path + branch (handles detached + missing branch)', () => {
		const porcelain = [
			'worktree /repo',
			'HEAD abcdef',
			'branch refs/heads/main',
			'',
			'worktree /sandbox/wt-1',
			'HEAD 123456',
			'branch refs/heads/run/abc',
			'',
			'worktree /sandbox/wt-detached',
			'HEAD deadbe',
			'detached',
		].join('\n')
		const records = parseWorktreeList(porcelain)
		expect(records).toEqual([
			{ path: '/repo', branch: 'main' },
			{ path: '/sandbox/wt-1', branch: 'run/abc' },
			{ path: '/sandbox/wt-detached', branch: null },
		])
	})
})

test.describe('workspace/worktree.server — real git integration', () => {
	test('resolveWorkspaceRoot returns worktrees/<runId> when worktree config + runId set', () => {
		const sandboxRoot = '/sandbox'
		const path = resolveWorkspaceRoot({
			userId: 'user1',
			runId: 'runABC',
			worktree: { repoPath: '/repo' },
			sandboxRoot,
		})
		expect(path).toMatch(/[\\/]sandbox[\\/]user1[\\/]worktrees[\\/]runABC$/)
	})

	test('persistentKey wins over worktree (priority order matches docs)', () => {
		const path = resolveWorkspaceRoot({
			userId: 'user1',
			runId: 'runABC',
			worktree: { repoPath: '/repo' },
			persistentKey: 'shared',
			sandboxRoot: '/sandbox',
		})
		expect(path).toMatch(/[\\/]sandbox[\\/]user1[\\/]persistent[\\/]shared$/)
	})

	test('ensureWorktree creates a real git worktree and is idempotent', async () => {
		test.setTimeout(30_000)
		const repoPath = await makeBareishRepo('worktree-create')
		const sandboxRoot = await makeTempDir('worktree-sandbox')
		const runId = `r${Date.now()}`
		const worktreePath = resolve(sandboxRoot, 'user1', 'worktrees', runId)
		try {
			const first = await ensureWorktree({ repoPath, worktreePath, runId })
			expect(first.created).toBe(true)
			expect(first.branch).toBe(`run/${runId}`)
			expect(await pathExists(worktreePath)).toBe(true)
			expect(await pathExists(resolve(worktreePath, 'README.md'))).toBe(true)
			expect(await pathExists(resolve(worktreePath, '.git'))).toBe(true)

			// Second call with the same runId is a no-op (idempotent on existing dir).
			const second = await ensureWorktree({ repoPath, worktreePath, runId })
			expect(second.created).toBe(false)
			expect(second.branch).toBe(`run/${runId}`)

			// listWorktrees from the source repo includes our new worktree.
			const list = await listWorktrees(repoPath)
			expect(list.find((w) => w.branch === `run/${runId}`)).toBeTruthy()
		} finally {
			await rm(sandboxRoot, { recursive: true, force: true })
			await rm(repoPath, { recursive: true, force: true })
		}
	})

	test('cleanupWorktree removes worktree registration and (optionally) the branch', async () => {
		test.setTimeout(30_000)
		const repoPath = await makeBareishRepo('worktree-cleanup')
		const sandboxRoot = await makeTempDir('worktree-sandbox')
		const runId = `r${Date.now()}`
		const worktreePath = resolve(sandboxRoot, 'user1', 'worktrees', runId)
		try {
			await ensureWorktree({ repoPath, worktreePath, runId })

			const result = await cleanupWorktree({ repoPath, worktreePath, runId, deleteBranch: true })
			expect(result.removed).toBe(true)
			expect(result.branchDeleted).toBe(true)

			// `worktree list` no longer mentions the path.
			const list = await listWorktrees(repoPath)
			expect(list.find((w) => w.branch === `run/${runId}`)).toBeFalsy()

			// `branch list` no longer has `run/<runId>`.
			const { stdout } = await git(repoPath, 'branch', '--list')
			expect(stdout).not.toMatch(new RegExp(`run/${runId}`))

			// Idempotent: cleaning up an already-removed worktree returns removed=false, no throw.
			const second = await cleanupWorktree({ repoPath, worktreePath, runId })
			expect(second.removed).toBe(false)
		} finally {
			await rm(sandboxRoot, { recursive: true, force: true })
			await rm(repoPath, { recursive: true, force: true })
		}
	})

	test('ensureWorkspace dispatches to ensureWorktree when worktree config present', async () => {
		test.setTimeout(30_000)
		const repoPath = await makeBareishRepo('ensure-ws-worktree')
		const sandboxRoot = await makeTempDir('ensure-ws-sandbox')
		const runId = `r${Date.now()}`
		try {
			const path = await ensureWorkspace({
				userId: 'user1',
				runId,
				worktree: { repoPath },
				sandboxRoot,
			})
			expect(path).toMatch(/worktrees[\\/]/)
			expect(await pathExists(resolve(path, 'README.md'))).toBe(true)
			expect(await pathExists(resolve(path, '.git'))).toBe(true)
		} finally {
			await rm(sandboxRoot, { recursive: true, force: true })
			await rm(repoPath, { recursive: true, force: true })
		}
	})
})

test.describe('workspace/gc — worktrees/ scan + removeWorktree hook', () => {
	test('GC scans <userId>/worktrees alongside <userId>/runs and invokes removeWorktree hook', async () => {
		test.setTimeout(30_000)
		const sandboxRoot = await makeTempDir('gc-worktree-scan')
		const runIdRun = randomUUID()
		const runIdWt = randomUUID()
		const removed: string[] = []
		try {
			// Seed: one ephemeral run dir and one worktree dir for the same fake user.
			const runDir = resolve(sandboxRoot, 'fakeUser', 'runs', runIdRun)
			const wtDir = resolve(sandboxRoot, 'fakeUser', 'worktrees', runIdWt)
			await mkdir(runDir, { recursive: true })
			await mkdir(wtDir, { recursive: true })
			await writeFile(resolve(runDir, 'note.txt'), 'r')
			await writeFile(resolve(wtDir, 'note.txt'), 'w')

			// Both runs are terminal + finished long enough ago.
			const lookupRuns: LookupRuns = async (ids: string[]) =>
				ids.map<RunStatusForGc>((id) => ({
					id,
					state: 'completed',
					finishedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
				}))

			const summary = await runWorkspaceGcCore({
				sandboxRoot,
				lookupRuns,
				ttlDays: 7,
				removeWorktree: async (path) => {
					removed.push(path)
				},
			})

			expect(summary.scanned).toBe(2)
			expect(summary.deleted).toBe(2)
			expect(removed.length, 'removeWorktree hook fires for the worktree path only').toBe(1)
			expect(removed[0]).toBe(wtDir)

			// kind labels populated correctly so an operator can tell the two scans apart.
			const kinds = summary.results.map((r) => r.kind).sort()
			expect(kinds).toEqual(['run', 'worktree'])

			// Both dirs gone from disk.
			expect(await pathExists(runDir)).toBe(false)
			expect(await pathExists(wtDir)).toBe(false)
		} finally {
			await rm(sandboxRoot, { recursive: true, force: true })
		}
	})

	test('removeWorktree errors are recorded but do not block the rm fallback', async () => {
		test.setTimeout(30_000)
		const sandboxRoot = await makeTempDir('gc-worktree-error')
		const runIdWt = randomUUID()
		try {
			const wtDir = resolve(sandboxRoot, 'fakeUser', 'worktrees', runIdWt)
			await mkdir(wtDir, { recursive: true })
			await writeFile(resolve(wtDir, 'leftover.txt'), 'leftover')

			const lookupRuns: LookupRuns = async (ids: string[]) =>
				ids.map<RunStatusForGc>((id) => ({
					id,
					state: 'completed',
					finishedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
				}))

			const summary = await runWorkspaceGcCore({
				sandboxRoot,
				lookupRuns,
				ttlDays: 7,
				removeWorktree: async () => {
					throw new Error('git not available')
				},
			})

			expect(summary.deleted, 'rm fallback still removed the dir').toBe(1)
			expect(summary.errors, 'the git error is surfaced in errors count').toBe(1)
			expect(summary.results[0].error).toMatch(/git not available/)
			expect(await pathExists(wtDir)).toBe(false)
		} finally {
			await rm(sandboxRoot, { recursive: true, force: true })
		}
	})
})
