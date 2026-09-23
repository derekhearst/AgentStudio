import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createUpstream, git, makeTempDir, startGitHttpServer, startRecordingSink } from './git-http-server'

/**
 * Server-side git runs outside the Bash sandbox, in repositories the agent can write. These
 * specs pin the hardening in `src/lib/source-control/git-exec{,.server}.ts`: a hostile
 * `.git/config` must not be able to run a program, read files outside the repository, or
 * send the GitHub token anywhere but the one URL it was meant for.
 *
 * The behavioural specs build a real repository with a real hostile config, run the
 * hardened `runGit`, and check that no marker file appeared — then run plain git on the
 * same repository to prove the trap was live.
 */

const slash = (p: string) => p.replace(/\\/g, '/')

test.describe('source-control/git-exec — invocation shape', () => {
	test('every call switches off the config keys that run programs', async () => {
		const { hardenedConfigArgs } = await import('../src/lib/source-control/git-exec')
		const args = hardenedConfigArgs()
		for (const pair of [
			'core.hooksPath=/dev/null',
			'core.fsmonitor=false',
			'core.askPass=',
			'credential.helper=',
			'core.alternateRefsCommand=true',
			'commit.gpgSign=false',
			'log.showSignature=false',
		]) {
			expect(args).toContain(pair)
		}
		// Caller extras go first so the hardening, read later, always wins.
		const withExtra = hardenedConfigArgs(['core.hooksPath=/tmp/evil'])
		expect(withExtra.indexOf('core.hooksPath=/tmp/evil')).toBeLessThan(withExtra.indexOf('core.hooksPath=/dev/null'))
	})

	test('the child environment is an allowlist, with the host git config switched off', async () => {
		const { buildHardenedGitEnv } = await import('../src/lib/source-control/git-exec')
		const env = buildHardenedGitEnv({
			PATH: '/usr/bin',
			HOME: '/data',
			DATABASE_URL: 'postgres://u:p@db/x',
			APP_ENCRYPTION_KEY: 'secret',
			GITHUB_OAUTH_CLIENT_SECRET: 'secret',
			GIT_DIR: '/elsewhere',
			SSH_ASKPASS: '/usr/bin/evil',
		})
		expect(env.PATH).toBe('/usr/bin')
		expect(env.HOME).toBe('/data')
		for (const leaked of ['DATABASE_URL', 'APP_ENCRYPTION_KEY', 'GITHUB_OAUTH_CLIENT_SECRET', 'GIT_DIR', 'SSH_ASKPASS']) {
			expect(env[leaked]).toBeUndefined()
		}
		expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
		expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
		expect(env.GIT_TERMINAL_PROMPT).toBe('0')
		expect(env.GIT_ASKPASS).toBe('')
		expect(env.GIT_ALLOW_PROTOCOL).toBe('https')
		expect(buildHardenedGitEnv({}, { remoteUrl: 'http://gitea.lan/a/b.git' }).GIT_ALLOW_PROTOCOL).toBe('https:http')
	})

	test('the token only ever travels as a header scoped to the exact remote URL', async () => {
		const { buildHardenedGitEnv, remoteAccessConfig } = await import('../src/lib/source-control/git-exec')
		const url = 'https://github.com/acme/widgets.git'
		const entries = remoteAccessConfig({ url, token: 'gho_secret', username: 'x-access-token' }, '')
		const header = entries.filter(([key]) => key === `http.${url}.extraHeader`)
		// Cleared first, then set: a repository cannot pre-load its own header next to ours.
		expect(header.map(([, value]) => value)).toEqual(['', `Authorization: Basic ${btoa('x-access-token:gho_secret')}`])
		expect(entries).toContainEqual([`http.${url}.sslVerify`, 'true'])
		expect(entries).toContainEqual([`http.${url}.proxy`, ''])
		expect(entries).toContainEqual([`remote.${url}.proxy`, ''])
		// Nothing is scoped wider than the URL itself.
		expect(entries.every(([key]) => key.startsWith(`http.${url}.`) || key.startsWith(`remote.${url}.`))).toBe(true)
		// And it reaches git through the environment, as a config entry.
		const env = buildHardenedGitEnv({}, { configEntries: entries, remoteUrl: url })
		expect(Number(env.GIT_CONFIG_COUNT)).toBe(entries.length)
		expect(Object.values(env).some((v) => v.includes(btoa('x-access-token:gho_secret')))).toBe(true)
		// Anonymous access sends no header at all.
		expect(remoteAccessConfig({ url, token: '' }, '').filter(([k, v]) => k.endsWith('.extraHeader') && v)).toEqual([])
	})

	test('every filter driver the repository names is neutralised by name', async () => {
		const { filterDriverOverrides } = await import('../src/lib/source-control/git-exec')
		const overrides = filterDriverOverrides(['filter.evil.clean', 'filter.evil.smudge', 'filter.a.b.process', 'core.bare'])
		expect(overrides).toContainEqual(['filter.evil.clean', ''])
		expect(overrides).toContainEqual(['filter.evil.smudge', ''])
		expect(overrides).toContainEqual(['filter.evil.required', 'false'])
		expect(overrides).toContainEqual(['filter.a.b.process', ''])
		expect(overrides.some(([key]) => key.startsWith('core.'))).toBe(false)
	})

	test('diff-producing and submodule-aware commands get their safety flags', async () => {
		const { subcommandHardeningFlags } = await import('../src/lib/source-control/git-exec')
		expect(subcommandHardeningFlags('diff', [])).toEqual(
			expect.arrayContaining(['--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty']),
		)
		expect(subcommandHardeningFlags('status', [])).toContain('--ignore-submodules=dirty')
		expect(subcommandHardeningFlags('push', [])).toEqual(expect.arrayContaining(['--no-verify', '--recurse-submodules=no']))
		expect(subcommandHardeningFlags('fetch', [])).toContain('--recurse-submodules=no')
	})

	test('refs shaped like options are refused; ordinary revisions are not', async () => {
		const { isSafeRevision, isSafeBranchName } = await import('../src/lib/source-control/git-exec')
		for (const hostile of ['--output=/etc/passwd', '-R', '--no-index', 'HEAD --output=x', 'a;b', '']) {
			expect(isSafeRevision(hostile)).toBe(false)
		}
		for (const ok of ['HEAD', 'HEAD~2', 'main...feature', 'origin/main', 'HEAD@{1}', 'v1.2.3', 'abc123f']) {
			expect(isSafeRevision(ok)).toBe(true)
		}
		for (const hostile of ['-f', 'a..b', 'a:b', 'refs/*', 'x.lock', '.hidden', 'a//b', 'trailing/']) {
			expect(isSafeBranchName(hostile)).toBe(false)
		}
		for (const ok of ['main', 'agent/123/attempt-2', 'release-1.2', 'feature/x']) {
			expect(isSafeBranchName(ok)).toBe(true)
		}
	})
})

test.describe('source-control/git-exec — a hostile .git/config runs nothing', () => {
	test('status, diff, add, commit and log run none of the programs the repository configures', async () => {
		const { runGit } = await import('../src/lib/source-control/git-exec.server')
		const tmp = makeTempDir('git-exec-hostile')
		try {
			const repo = join(tmp.path, 'repo')
			const marker = slash(join(tmp.path, 'pwned.txt'))
			git(['init', '-b', 'main', repo])
			writeFileSync(join(repo, 'a.txt'), 'hello\n')
			git(['add', '-A'], repo)
			git(['commit', '-m', 'init'], repo)

			const run = (tag: string) => `"sh -c 'echo ${tag} >> ${marker}; cat'"`
			appendFileSync(
				join(repo, '.git', 'config'),
				[
					'[core]',
					`\tfsmonitor = "sh -c 'echo FSMONITOR >> ${marker}'"`,
					'[filter "evil"]',
					`\tclean = ${run('CLEAN')}`,
					`\tsmudge = ${run('SMUDGE')}`,
					'\trequired = true',
					'[diff "evil"]',
					`\ttextconv = "sh -c 'echo TEXTCONV >> ${marker}; cat \\"$0\\"'"`,
					`\tcommand = "sh -c 'echo EXTDIFF >> ${marker}'"`,
					'[commit]',
					'\tgpgSign = true',
					'[gpg]',
					`\tprogram = "sh -c 'echo GPG >> ${marker}'"`,
					'[credential]',
					`\thelper = "!f() { echo HELPER >> ${marker}; }; f"`,
					'',
				].join('\n'),
			)
			writeFileSync(join(repo, '.gitattributes'), '* filter=evil diff=evil\n')
			mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
			for (const hook of ['pre-commit', 'commit-msg', 'post-commit']) {
				const path = join(repo, '.git', 'hooks', hook)
				writeFileSync(path, `#!/bin/sh\necho HOOK-${hook} >> "${marker}"\n`)
				chmodSync(path, 0o755)
			}
			appendFileSync(join(repo, 'a.txt'), 'changed\n')

			const status = await runGit(['status', '--porcelain'], { repoPath: repo })
			expect(status.code).toBe(0)
			expect(status.stdout).toContain('a.txt')
			const diff = await runGit(['diff', 'HEAD'], { repoPath: repo })
			expect(diff.code).toBe(0)
			expect(diff.stdout).toContain('+changed')
			expect((await runGit(['add', '-A'], { repoPath: repo })).code).toBe(0)
			const commit = await runGit(['commit', '-m', 'second'], { repoPath: repo, config: ['user.name=T', 'user.email=t@e'] })
			expect(commit.code).toBe(0)
			expect((await runGit(['log', '--oneline'], { repoPath: repo })).stdout).toContain('second')

			expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('')

			// Control: the same repository, plain git. If this writes nothing, the trap above
			// was never armed and the assertions proved nothing.
			appendFileSync(join(repo, 'a.txt'), 'again\n')
			git(['status', '--porcelain'], repo)
			git(['diff', 'HEAD'], repo)
			expect(readFileSync(marker, 'utf8')).toMatch(/FSMONITOR|CLEAN/)
		} finally {
			tmp.cleanup()
		}
	})

	test('core.worktree cannot aim a status or diff at files outside the repository', async () => {
		const { runGit } = await import('../src/lib/source-control/git-exec.server')
		const tmp = makeTempDir('git-exec-worktree')
		try {
			const repo = join(tmp.path, 'repo')
			const outside = join(tmp.path, 'outside')
			mkdirSync(outside)
			writeFileSync(join(outside, 'secret.txt'), 'SECRET\n')
			git(['init', '-b', 'main', repo])
			writeFileSync(join(repo, 'mine.txt'), 'mine\n')
			git(['config', 'core.worktree', slash(outside)], repo)

			const status = await runGit(['status', '--porcelain'], { repoPath: repo })
			expect(status.code).toBe(0)
			expect(status.stdout).toContain('mine.txt')
			expect(status.stdout).not.toContain('secret.txt')

			// Control: unpinned, git really does list the outside directory.
			expect(git(['status', '--porcelain'], repo)).toContain('secret.txt')
		} finally {
			tmp.cleanup()
		}
	})
})

test.describe('source-control/git-exec — the token goes to one URL only', () => {
	test('the Authorization header reaches the exact remote URL, and never argv or output', async () => {
		const { runGit } = await import('../src/lib/source-control/git-exec.server')
		const tmp = makeTempDir('git-exec-auth')
		const server = await startGitHttpServer(tmp.path)
		try {
			createUpstream(tmp.path)
			const url = `${server.origin}/upstream.git`
			const expected = `Basic ${btoa('x-access-token:tok-123')}`
			server.requireAuthorization = expected
			const res = await runGit(['ls-remote', url], { cwd: tmp.path, remote: { url, token: 'tok-123' } })
			expect(res.code).toBe(0)
			expect(res.stdout).toContain('refs/heads/main')
			expect(server.requests.length).toBeGreaterThan(0)
			expect(server.requests.every((r) => r.authorization === expected)).toBe(true)
			expect(res.stdout + res.stderr).not.toContain('tok-123')
		} finally {
			await server.close()
			tmp.cleanup()
		}
	})

	test('a url.insteadOf rewrite in the repository sends the request elsewhere without the token', async () => {
		const { runGit } = await import('../src/lib/source-control/git-exec.server')
		const tmp = makeTempDir('git-exec-insteadof')
		const server = await startGitHttpServer(tmp.path)
		try {
			createUpstream(tmp.path)
			createUpstream(tmp.path, 'decoy.git')
			const url = `${server.origin}/upstream.git`
			const repo = join(tmp.path, 'repo')
			git(['init', '-b', 'main', repo])
			git(['config', `url.${server.origin}/decoy.git.insteadOf`, url], repo)

			await runGit(['fetch', url, '+refs/heads/*:refs/remotes/origin/*'], {
				repoPath: repo,
				remote: { url, token: 'tok-456' },
			})
			const decoyHits = server.requests.filter((r) => r.url.startsWith('/decoy.git'))
			// The rewrite still happens — git has no switch for that — but the header was
			// scoped to the URL we named, so the rewritten destination never sees the token.
			expect(decoyHits.length).toBeGreaterThan(0)
			expect(decoyHits.every((r) => r.authorization === null)).toBe(true)
		} finally {
			await server.close()
			tmp.cleanup()
		}
	})

	test('a proxy the repository configures for the remote URL is ignored', async () => {
		const { runGit } = await import('../src/lib/source-control/git-exec.server')
		const tmp = makeTempDir('git-exec-proxy')
		const server = await startGitHttpServer(tmp.path)
		const sink = await startRecordingSink()
		try {
			createUpstream(tmp.path)
			const url = `${server.origin}/upstream.git`
			const repo = join(tmp.path, 'repo')
			git(['init', '-b', 'main', repo])
			git(['config', `http.${url}.proxy`, sink.origin], repo)
			git(['config', `remote.${url}.proxy`, sink.origin], repo)

			const res = await runGit(['ls-remote', url], { repoPath: repo, remote: { url, token: 'tok-789' } })
			expect(res.code).toBe(0)
			expect(sink.hits).toEqual([])
		} finally {
			await sink.close()
			await server.close()
			tmp.cleanup()
		}
	})

	test('when the remote refuses the token, no repository helper or askpass program runs', async () => {
		const { runGit } = await import('../src/lib/source-control/git-exec.server')
		const tmp = makeTempDir('git-exec-helper')
		const server = await startGitHttpServer(tmp.path)
		try {
			createUpstream(tmp.path)
			const url = `${server.origin}/upstream.git`
			const marker = slash(join(tmp.path, 'pwned.txt'))
			const askpass = join(tmp.path, 'askpass.sh')
			writeFileSync(askpass, `#!/bin/sh\necho ASKPASS >> "${marker}"\necho password\n`)
			chmodSync(askpass, 0o755)
			const repo = join(tmp.path, 'repo')
			git(['init', '-b', 'main', repo])
			appendFileSync(
				join(repo, '.git', 'config'),
				[
					'[credential]',
					`\thelper = "!f() { echo HELPER-$1 >> ${marker}; }; f"`,
					'[core]',
					`\taskPass = ${slash(askpass)}`,
					'',
				].join('\n'),
			)
			server.requireAuthorization = 'Basic something-else'

			const res = await runGit(['ls-remote', url], { repoPath: repo, remote: { url, token: 'tok-000' } })
			expect(res.code).not.toBe(0)
			expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('')
		} finally {
			await server.close()
			tmp.cleanup()
		}
	})

	test('a rewrite to another transport is refused outright', async () => {
		const { runGit } = await import('../src/lib/source-control/git-exec.server')
		const tmp = makeTempDir('git-exec-protocol')
		try {
			const bare = createUpstream(tmp.path)
			const url = 'https://github.com/acme/widgets.git'
			const repo = join(tmp.path, 'repo')
			git(['init', '-b', 'main', repo])
			git(['config', `url.file://${slash(bare)}.insteadOf`, url], repo)
			git(['config', 'protocol.file.allow', 'always'], repo)

			const res = await runGit(['fetch', url], { repoPath: repo, remote: { url, token: 'tok' } })
			expect(res.code).not.toBe(0)
			expect(res.stderr).toMatch(/not allowed/)
		} finally {
			tmp.cleanup()
		}
	})
})
