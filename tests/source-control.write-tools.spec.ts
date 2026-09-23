import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { commitUpstream, createUpstream, git, makeTempDir, startGitHttpServer } from './git-http-server'

/**
 * Wave 5 #19 phase 3 finish — write-tool argv builder + approval-set invariants.
 *
 * The push + PR tools are HTTPS-bound to GitHub via the user's stored OAuth token. We
 * can't exercise GitHub in unit tests, so this spec pins the structural contracts that
 * gate safety — the argv never carries the token, branch names cannot smuggle options or
 * refspecs, and the mandatory-approval set carries both tool names so chat-stream can
 * never accidentally turn approval off — and runs the push itself against a local HTTP
 * remote to pin how `--force-with-lease` behaves.
 */

test.describe('source-control/git-push — argv builder', () => {
	test('pushes a fully-qualified refspec to the URL, with no token and no credential helper in argv', async () => {
		const { buildPushArgs } = await import('../src/lib/source-control/git-push.server')
		const args = buildPushArgs({ remote: 'https://github.com/acme/widgets.git', branch: 'feature/x' })
		expect(args[0]).toBe('push')
		expect(args).toContain('https://github.com/acme/widgets.git')
		// A fully-qualified refspec so the local branch tracking config never surprises us
		// with a different remote ref name.
		expect(args).toContain('refs/heads/feature/x:refs/heads/feature/x')
		// The token travels as a URL-scoped header in the child environment (git-exec.ts).
		expect(args.join(' ')).not.toContain('credential.helper')
	})

	test('force=true spells the lease out, and never uses plain --force', async () => {
		const { buildPushArgs } = await import('../src/lib/source-control/git-push.server')
		const remote = 'https://github.com/a/b.git'
		const safe = buildPushArgs({ remote, branch: 'main' })
		const forced = buildPushArgs({ remote, branch: 'main', force: true, leaseExpected: 'abc123' })
		const neverSeen = buildPushArgs({ remote, branch: 'main', force: true, leaseExpected: '' })
		expect(safe.some((a) => a.startsWith('--force'))).toBe(false)
		// A bare `--force-with-lease` to a URL has no tracking ref to consult and rejects every
		// existing branch as "stale info" — the lease must name its expected commit.
		expect(forced).toContain('--force-with-lease=refs/heads/main:abc123')
		expect(neverSeen).toContain('--force-with-lease=refs/heads/main:')
		expect(forced).not.toContain('--force-with-lease')
		expect(forced).not.toContain('--force')
	})

	test('branch names shaped like options or refspecs are refused before git runs', async () => {
		const { buildPushArgs } = await import('../src/lib/source-control/git-push.server')
		const remote = 'https://github.com/a/b.git'
		for (const branch of ['--delete', 'x:refs/heads/main', 'refs/*', 'a..b']) {
			expect(() => buildPushArgs({ remote, branch })).toThrow(/Invalid branch name/)
		}
	})

	test('owner and repo are validated as path segments', async () => {
		const { pushBranchToGithub } = await import('../src/lib/source-control/git-push.server')
		const tmp = makeTempDir('push-validate')
		try {
			git(['init', '-b', 'main', tmp.path])
			await expect(
				pushBranchToGithub({ repoPath: tmp.path, owner: 'evil.com/x#', repo: 'r', branch: 'main', token: 't' }),
			).rejects.toThrow(/Invalid owner segment/)
		} finally {
			tmp.cleanup()
		}
	})
})

test.describe('source-control/git-push — force-with-lease against a real remote', () => {
	test('a rewritten branch force-pushes; a branch someone else moved is refused with a hint', async () => {
		const { pushBranch } = await import('../src/lib/source-control/git-push.server')
		const { refreshClone } = await import('../src/lib/source-control/repo-mirror.server')
		const tmp = makeTempDir('push-lease')
		const server = await startGitHttpServer(tmp.path)
		try {
			const bare = createUpstream(tmp.path)
			const remote = `${server.origin}/upstream.git`
			// Cloned from the path (a synchronous git call must not wait on this process's own
			// HTTP server), then pointed at the served URL like any AgentStudio clone.
			const clone = join(tmp.path, 'clone')
			git(['clone', '-q', bare, clone])
			git(['remote', 'set-url', 'origin', remote], clone)
			git(['checkout', '-b', 'agent/1'], clone)
			writeFileSync(join(clone, 'work.txt'), 'v1\n')
			git(['add', '-A'], clone)
			git(['commit', '-m', 'v1'], clone)

			const first = await pushBranch({ repoPath: clone, remote, branch: 'agent/1', token: '' })
			expect(first.success).toBe(true)
			// The push is recorded where the next lease will look for it.
			expect(git(['rev-parse', 'refs/remotes/origin/agent/1'], clone)).toBe(git(['rev-parse', 'HEAD'], clone))

			// Rewrite and force-push: the lease holds, because nobody else touched the branch.
			writeFileSync(join(clone, 'work.txt'), 'v2\n')
			git(['add', '-A'], clone)
			git(['commit', '--amend', '-m', 'v2'], clone)
			const rewritten = await pushBranch({ repoPath: clone, remote, branch: 'agent/1', token: '', force: true })
			expect(rewritten.stderr).not.toMatch(/stale info/)
			expect(rewritten.success).toBe(true)
			expect(git(['rev-parse', 'refs/heads/agent/1'], bare)).toBe(git(['rev-parse', 'HEAD'], clone))

			// Someone else pushes. Our next force-push must refuse to overwrite what we never saw.
			const theirs = commitUpstream(tmp.path, bare, 'agent/1', 'theirs.txt', 'theirs\n')
			git(['commit', '--amend', '-m', 'v3'], clone)
			const refused = await pushBranch({ repoPath: clone, remote, branch: 'agent/1', token: '', force: true })
			expect(refused.success).toBe(false)
			expect(refused.stderr).toMatch(/stale info/)
			expect(refused.stderr).toMatch(/Pull latest/)
			expect(git(['rev-parse', 'refs/heads/agent/1'], bare)).toBe(theirs)

			// Once we have fetched their work, the lease is ours to break deliberately.
			await refreshClone({ repoPath: clone, remoteUrl: remote, token: '' })
			const afterFetch = await pushBranch({ repoPath: clone, remote, branch: 'agent/1', token: '', force: true })
			expect(afterFetch.success).toBe(true)
		} finally {
			await server.close()
			tmp.cleanup()
		}
	})

	test('a push target that is not origin keeps its own record, so the lease works there too', async () => {
		const { pushBranch, pushRecordRef } = await import('../src/lib/source-control/git-push.server')
		const tmp = makeTempDir('push-lease-record')
		const server = await startGitHttpServer(tmp.path)
		try {
			const bare = createUpstream(tmp.path)
			const remote = `${server.origin}/upstream.git`
			// A local project: its own history, and no `origin` at all.
			const project = join(tmp.path, 'project')
			git(['init', '-b', 'agent/2', project])
			writeFileSync(join(project, 'work.txt'), 'v1\n')
			git(['add', '-A'], project)
			git(['commit', '-m', 'v1'], project)
			const record = pushRecordRef(remote, 'agent/2')

			const first = await pushBranch({ repoPath: project, remote, branch: 'agent/2', token: '' })
			expect(first.success).toBe(true)
			expect(git(['rev-parse', record], project)).toBe(git(['rev-parse', 'HEAD'], project))

			// Rewrite and force-push. With only `origin/<branch>` to go on this was always
			// "stale info"; the record makes it the ordinary case.
			git(['commit', '--amend', '-m', 'v2'], project)
			const rewritten = await pushBranch({ repoPath: project, remote, branch: 'agent/2', token: '', force: true })
			expect(rewritten.stderr).not.toMatch(/stale info/)
			expect(rewritten.success).toBe(true)
			expect(git(['rev-parse', 'refs/heads/agent/2'], bare)).toBe(git(['rev-parse', 'HEAD'], project))
			expect(git(['rev-parse', record], project)).toBe(git(['rev-parse', 'HEAD'], project))

			// Someone else pushes: the lease still holds the line.
			const theirs = commitUpstream(tmp.path, bare, 'agent/2', 'theirs.txt', 'theirs\n')
			git(['commit', '--amend', '-m', 'v3'], project)
			const refused = await pushBranch({ repoPath: project, remote, branch: 'agent/2', token: '', force: true })
			expect(refused.success).toBe(false)
			expect(refused.stderr).toMatch(/stale info/)
			expect(refused.stderr).toMatch(/not where AgentStudio last pushed it/)
			expect(git(['rev-parse', 'refs/heads/agent/2'], bare)).toBe(theirs)

			// And a branch AgentStudio never pushed there is never overwritten by a force-push.
			git(['checkout', '-q', '-b', 'main'], project)
			const neverPushed = await pushBranch({ repoPath: project, remote, branch: 'main', token: '', force: true })
			expect(neverPushed.success).toBe(false)
			expect(neverPushed.stderr).toMatch(/stale info/)
		} finally {
			await server.close()
			tmp.cleanup()
		}
	})

	test('push records are keyed by the target repository', async () => {
		const { pushRecordRef } = await import('../src/lib/source-control/git-push.server')
		expect(pushRecordRef('https://github.com/Acme/Widgets.git', 'agent/1')).toBe(
			'refs/agentstudio/pushed/github.com/acme/widgets/agent/1',
		)
		// GitHub compares owner and repo without case, so the record does too.
		expect(pushRecordRef('https://github.com/acme/widgets', 'agent/1')).toBe(
			pushRecordRef('https://github.com/ACME/widgets.git', 'agent/1'),
		)
		const other = pushRecordRef('https://gitea.example/team/app.git', 'main')
		expect(other).toMatch(/^refs\/agentstudio\/pushed\/url\/[0-9a-f]{24}\/main$/)
		expect(other).not.toBe(pushRecordRef('https://gitea.example/team/other.git', 'main'))
		expect(() => pushRecordRef('https://github.com/a/b.git', '--delete')).toThrow(/Invalid branch name/)
	})
})

test.describe('source-control — mandatory approval set', () => {
	test('push_branch and create_pull_request are both flagged as always-require-approval', async () => {
		const { MANDATORY_APPROVAL_TOOLS } = await import('../src/lib/tools/tools')
		const set = new Set<string>(MANDATORY_APPROVAL_TOOLS)
		expect(set.has('push_branch')).toBe(true)
		expect(set.has('create_pull_request')).toBe(true)
	})

	test('source-control read + write tools are all registered in the tool registry', async () => {
		const { allToolNames } = await import('../src/lib/tools/tool-schemas')
		expect(allToolNames).toEqual(
			expect.arrayContaining(['list_my_repos', 'sync_my_repos', 'prepare_commit', 'push_branch', 'create_pull_request']),
		)
	})
})
