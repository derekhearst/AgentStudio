import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { commitUpstream, createUpstream, git, makeTempDir, startGitHttpServer } from './git-http-server'

/**
 * Wave 5 #19 phase 2 (mirror slice) — argv-builder + path-bounding contract for
 * `materializeRepoMirror`, and the refresh that keeps an existing clone current.
 *
 * The refresh specs run real git against a local HTTP remote (`git-http-server.ts`): clone,
 * move the upstream on, refresh, and check what the clone now points at. They exist because
 * the refresh used to fetch a bare URL with no refspec, which writes FETCH_HEAD and nothing
 * else — every "pull latest" reported success and changed nothing.
 */

test.describe('source-control/repo-mirror — argv builders', () => {
	test('buildCloneArgs takes no token, so none can reach argv', async () => {
		const { buildCloneArgs } = await import('../src/lib/source-control/repo-mirror')
		const args = buildCloneArgs({
			remoteUrl: 'https://github.com/acme/widgets.git',
			targetPath: '/sandbox/u1/repos/acme/widgets',
		})
		expect(args[0]).toBe('clone')
		expect(args).toContain('https://github.com/acme/widgets.git')
		expect(args).toContain('/sandbox/u1/repos/acme/widgets')
		expect(args).toContain('--no-tags') // we never need tag history for the mirror's purpose
		// No credential helper: the token travels as a URL-scoped header in the environment.
		expect(args.join(' ')).not.toContain('credential.helper')
	})

	test('buildFetchArgs names a refspec, so the fetch updates origin/* instead of only FETCH_HEAD', async () => {
		const { buildFetchArgs, REMOTE_TRACKING_REFSPEC } = await import('../src/lib/source-control/repo-mirror')
		const args = buildFetchArgs({ remoteUrl: 'https://github.com/acme/widgets.git' })
		expect(args[0]).toBe('fetch')
		expect(args).toContain('--prune')
		expect(args).toContain('https://github.com/acme/widgets.git')
		expect(args[args.length - 1]).toBe(REMOTE_TRACKING_REFSPEC)
		expect(REMOTE_TRACKING_REFSPEC).toBe('+refs/heads/*:refs/remotes/origin/*')
	})
})

test.describe('source-control/repo-mirror — path containment', () => {
	test('buildMirrorPath joins owner + repo under the configured mirror root', async () => {
		const { buildMirrorPath } = await import('../src/lib/source-control/repo-mirror')
		const path = buildMirrorPath('/sandbox/u1/repos', 'acme', 'widgets')
		// Don't pin the separator (Windows vs Unix differs); just check the segments are present.
		expect(path).toContain('acme')
		expect(path).toContain('widgets')
		expect(path.startsWith('/sandbox/u1/repos') || path.startsWith('\\sandbox\\u1\\repos')).toBe(true)
	})

	test('hostile owner/repo segments are rejected before any path is built', async () => {
		const { buildMirrorPath } = await import('../src/lib/source-control/repo-mirror')
		// Path traversal attempt
		expect(() => buildMirrorPath('/root', '../escape', 'repo')).toThrow(/Invalid owner segment/)
		// Slash in repo name
		expect(() => buildMirrorPath('/root', 'owner', 'repo/sub')).toThrow(/Invalid repo segment/)
		// Empty
		expect(() => buildMirrorPath('/root', '', 'repo')).toThrow(/Invalid owner segment/)
		// Leading dot is rejected by the regex (avoids hidden-dir creation)
		expect(() => buildMirrorPath('/root', '.hidden', 'repo')).toThrow(/Invalid owner segment/)
	})

	test('legitimate names with dots / underscores / dashes are accepted', async () => {
		const { buildMirrorPath } = await import('../src/lib/source-control/repo-mirror')
		expect(() => buildMirrorPath('/root', 'a.b-c_d', 'repo.name')).not.toThrow()
	})
})

test.describe('source-control/repo-mirror — refreshing an existing clone', () => {
	test('a refresh moves origin/* and fast-forwards the checked-out branch', async () => {
		const { materializeRepoMirror } = await import('../src/lib/source-control/repo-mirror.server')
		const tmp = makeTempDir('mirror-refresh')
		const server = await startGitHttpServer(tmp.path)
		try {
			const bare = createUpstream(tmp.path)
			const cloneUrl = `${server.origin}/upstream.git`
			const mirrorRoot = join(tmp.path, 'mirrors')
			const input = { mirrorRoot, owner: 'acme', repo: 'widgets', token: '', cloneUrl, credentialUsername: '' }

			const first = await materializeRepoMirror(input)
			expect(first.fresh).toBe(true)
			expect(first.branch).toBe('main')
			const day1 = git(['rev-parse', 'HEAD'], first.path)

			// Someone pushes to main, and opens a new branch.
			const day5 = commitUpstream(tmp.path, bare, 'main', 'news.txt', 'new\n')
			git(['branch', 'feature', 'main'], bare)

			const second = await materializeRepoMirror(input)
			expect(second.fresh).toBe(false)
			expect(second.refresh?.status).toBe('fast-forwarded')
			expect(git(['rev-parse', 'refs/remotes/origin/main'], second.path)).toBe(day5)
			expect(git(['rev-parse', 'refs/remotes/origin/feature'], second.path)).toBe(day5)
			expect(git(['rev-parse', 'HEAD'], second.path)).toBe(day5)
			expect(day5).not.toBe(day1)

			// Nothing new upstream: the second refresh says so rather than claiming a move.
			const third = await materializeRepoMirror(input)
			expect(third.refresh?.status).toBe('up-to-date')
		} finally {
			await server.close()
			tmp.cleanup()
		}
	})

	test('a branch with local commits is left alone, and the outcome says why', async () => {
		const { materializeRepoMirror } = await import('../src/lib/source-control/repo-mirror.server')
		const tmp = makeTempDir('mirror-diverged')
		const server = await startGitHttpServer(tmp.path)
		try {
			const bare = createUpstream(tmp.path)
			const input = {
				mirrorRoot: join(tmp.path, 'mirrors'),
				owner: 'acme',
				repo: 'widgets',
				token: '',
				cloneUrl: `${server.origin}/upstream.git`,
				credentialUsername: '',
			}
			const { path } = await materializeRepoMirror(input)
			writeFileSync(join(path, 'local.txt'), 'agent work\n')
			git(['add', '-A'], path)
			git(['commit', '-m', 'agent work'], path)
			const local = git(['rev-parse', 'HEAD'], path)
			const upstream = commitUpstream(tmp.path, bare, 'main', 'news.txt', 'new\n')

			const refreshed = await materializeRepoMirror(input)
			expect(refreshed.refresh).toEqual({ status: 'skipped', branch: 'main', reason: 'diverged' })
			expect(refreshed.refreshSummary).toMatch(/not fast-forwarded/)
			// The remote's state is still recorded; the agent's commit is untouched.
			expect(git(['rev-parse', 'refs/remotes/origin/main'], path)).toBe(upstream)
			expect(git(['rev-parse', 'HEAD'], path)).toBe(local)
		} finally {
			await server.close()
			tmp.cleanup()
		}
	})

	test('a deleted remote branch is pruned from origin/*', async () => {
		const { materializeRepoMirror } = await import('../src/lib/source-control/repo-mirror.server')
		const tmp = makeTempDir('mirror-prune')
		const server = await startGitHttpServer(tmp.path)
		try {
			const bare = createUpstream(tmp.path)
			git(['branch', 'short-lived', 'main'], bare)
			const input = {
				mirrorRoot: join(tmp.path, 'mirrors'),
				owner: 'acme',
				repo: 'widgets',
				token: '',
				cloneUrl: `${server.origin}/upstream.git`,
				credentialUsername: '',
			}
			const { path } = await materializeRepoMirror(input)
			expect(git(['branch', '-r'], path)).toContain('origin/short-lived')
			git(['branch', '-D', 'short-lived'], bare)
			await materializeRepoMirror(input)
			expect(git(['branch', '-r'], path)).not.toContain('origin/short-lived')
		} finally {
			await server.close()
			tmp.cleanup()
		}
	})
})
