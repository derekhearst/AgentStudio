import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createUpstream, git, gitAsync, makeTempDir, startGitHttpServer, startRecordingSink } from './git-http-server'

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
const readMarker = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

/** A repository at `path` with one commit of `a.txt`. */
function initRepo(path: string): string {
	git(['init', '-b', 'main', path])
	writeFileSync(join(path, 'a.txt'), 'one\n')
	git(['add', '-A'], path)
	git(['commit', '-m', 'init'], path)
	return path
}

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
			// A submodule is summarised in one line, never diffed by a git started inside it.
			'diff.submodule=short',
			'status.submoduleSummary=false',
			'diff.ignoreSubmodules=dirty',
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
			GIT_SSL_CAINFO: '/etc/ssl/corp-ca.pem',
		})
		expect(env.PATH).toBe('/usr/bin')
		expect(env.HOME).toBe('/data')
		// The operator's own CA bundle is theirs to set, and git reads it from the environment.
		expect(env.GIT_SSL_CAINFO).toBe('/etc/ssl/corp-ca.pem')
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
		// No cookie jar: curl would write it wherever the repository pointed it.
		expect(entries).toContainEqual([`http.${url}.cookieFile`, ''])
		expect(entries).toContainEqual([`http.${url}.saveCookies`, 'false'])
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

	test('a repository that would redirect a remote call is recognised from its config names', async () => {
		const { remoteRedirectKeys } = await import('../src/lib/source-control/git-exec')
		const url = 'https://github.com/acme/widgets.git'
		const names = [
			'remote.origin.url',
			'remote.origin.fetch',
			'http.postBuffer',
			'url.https://evil.example/.insteadOf',
			'url.https://evil.example/.pushInsteadOf',
			`remote.${url}.url`,
			`remote.${url}.mirror`,
			`http.${url}.cookieFile`,
			'http.https://github.com/.sslCAInfo',
		]
		expect(remoteRedirectKeys(names, url)).toEqual([
			'url.https://evil.example/.insteadOf',
			'url.https://evil.example/.pushInsteadOf',
			`remote.${url}.url`,
			`remote.${url}.mirror`,
			`http.${url}.cookieFile`,
			'http.https://github.com/.sslCAInfo',
		])
		// A named remote and unscoped http settings are not redirects: the URL-scoped pins win.
		expect(remoteRedirectKeys(['remote.origin.url', 'http.proxy', 'http.cookieFile'], url)).toEqual([])
	})

	test('submodule entries are picked out of the index listing', async () => {
		const { gitlinkPathFromStageRecord, filterDriverNames } = await import('../src/lib/source-control/git-exec')
		expect(gitlinkPathFromStageRecord('160000 3f786850e387550fdab836ed7e6dc881de23001b 0\tvendor/lib')).toBe('vendor/lib')
		expect(gitlinkPathFromStageRecord('100644 3f786850e387550fdab836ed7e6dc881de23001b 0\tREADME.md')).toBeNull()
		expect(gitlinkPathFromStageRecord('160000 3f78 0')).toBeNull()
		// Driver names keep their case and dots; an empty name is still a name git would use.
		expect(filterDriverNames(['filter.Evil.clean', 'filter.a.b.smudge', 'filter..clean', 'core.bare']).sort()).toEqual(
			['', 'Evil', 'a.b'].sort(),
		)
	})

	test('diff-producing and submodule-aware commands get their safety flags', async () => {
		const { subcommandHardeningFlags } = await import('../src/lib/source-control/git-exec')
		expect(subcommandHardeningFlags('diff', [])).toEqual(
			expect.arrayContaining(['--no-ext-diff', '--no-textconv', '--submodule=short', '--ignore-submodules=dirty']),
		)
		expect(subcommandHardeningFlags('log', [])).toContain('--submodule=short')
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

	test('a filter config too large to read in full refuses the command instead of running it unprotected', async () => {
		const { runGit, GitRefusedError } = await import('../src/lib/source-control/git-exec.server')
		const tmp = makeTempDir('git-exec-oversized')
		try {
			const repo = initRepo(join(tmp.path, 'repo'))
			const marker = slash(join(tmp.path, 'pwned.txt'))
			// A live driver first, then enough padding that its names alone pass a megabyte —
			// the size at which an output-capped scan used to give up and report "no drivers".
			const lines = ['[filter "evil"]', `\tclean = "sh -c 'echo CLEAN >> ${marker}; cat'"`, '\trequired = true']
			const pad = 'x'.repeat(60)
			for (let i = 0; i < 16_000; i++) lines.push(`[filter "pad-${i}-${pad}"]`, '\tfoo = 1')
			appendFileSync(join(repo, '.git', 'config'), `${lines.join('\n')}\n`)
			writeFileSync(join(repo, '.gitattributes'), '* filter=evil\n')
			appendFileSync(join(repo, 'a.txt'), 'changed\n')

			for (const args of [['add', '-A'], ['status', '--porcelain'], ['diff']]) {
				await expect(runGit(args, { repoPath: repo })).rejects.toBeInstanceOf(GitRefusedError)
			}
			expect(readMarker(marker)).toBe('')

			// Control: plain git runs the driver on the same repository.
			git(['add', '-A'], repo)
			expect(readMarker(marker)).toContain('CLEAN')
		} finally {
			tmp.cleanup()
		}
	})

	test('more filter drivers than the limit refuses the command', async () => {
		const { runGit, GitRefusedError } = await import('../src/lib/source-control/git-exec.server')
		const { GIT_SCAN_LIMITS } = await import('../src/lib/source-control/git-exec')
		const tmp = makeTempDir('git-exec-many-drivers')
		try {
			const repo = initRepo(join(tmp.path, 'repo'))
			const lines: string[] = []
			for (let i = 0; i <= GIT_SCAN_LIMITS.filterDrivers; i++) lines.push(`[filter "d${i}"]`, '\tclean = cat')
			appendFileSync(join(repo, '.git', 'config'), `${lines.join('\n')}\n`)
			await expect(runGit(['status', '--porcelain'], { repoPath: repo })).rejects.toThrow(/more than \d+ defined/)
			await expect(runGit(['status'], { repoPath: repo })).rejects.toBeInstanceOf(GitRefusedError)
		} finally {
			tmp.cleanup()
		}
	})

	test("a submodule's own diff program does not run when the superproject asks for inline submodule diffs", async () => {
		const { runGit } = await import('../src/lib/source-control/git-exec.server')
		const tmp = makeTempDir('git-exec-submodule-diff')
		try {
			const marker = slash(join(tmp.path, 'pwned.txt'))
			const superproject = initRepo(join(tmp.path, 'super'))
			// An embedded repository added as a submodule entry, then moved on by one commit, so
			// the superproject sees the submodule changed.
			const sub = initRepo(join(superproject, 'sub'))
			git(['add', 'sub'], superproject)
			git(['commit', '-m', 'add sub'], superproject)
			appendFileSync(join(sub, 'a.txt'), 'two\n')
			git(['commit', '-am', 'two'], sub)
			git(['config', 'diff.submodule', 'diff'], superproject)
			git(['config', 'diff.external', `sh -c 'echo SUBMODULE-EXTDIFF >> ${marker}'`], sub)

			const diff = await runGit(['diff'], { repoPath: superproject })
			expect(diff.code).toBe(0)
			expect(diff.stdout).toContain('Subproject commit')
			const log = await runGit(['log', '-p', '-1'], { repoPath: superproject })
			expect(log.code).toBe(0)
			expect(readMarker(marker)).toBe('')

			// Control: plain git diffs inside the submodule, with the submodule's program.
			git(['diff'], superproject)
			expect(readMarker(marker)).toContain('SUBMODULE-EXTDIFF')
		} finally {
			tmp.cleanup()
		}
	})

	test("a filter driver defined only in a checked-out submodule's config does not run", async () => {
		const { runGit } = await import('../src/lib/source-control/git-exec.server')
		const tmp = makeTempDir('git-exec-submodule-filter')
		try {
			const marker = slash(join(tmp.path, 'pwned.txt'))
			// A real submodule — a .git file pointing into the superproject's .git/modules — so
			// the scan has to follow it, as the git it protects against does.
			const upstream = initRepo(join(tmp.path, 'lib'))
			writeFileSync(join(upstream, '.gitattributes'), '*.txt filter=subevil\n')
			git(['add', '-A'], upstream)
			git(['commit', '-m', 'attributes'], upstream)
			const superproject = initRepo(join(tmp.path, 'super'))
			git(['-c', 'protocol.file.allow=always', 'submodule', 'add', slash(upstream), 'lib'], superproject)
			git(['commit', '-m', 'add lib'], superproject)
			const sub = join(superproject, 'lib')
			expect(statSync(join(sub, '.git')).isFile()).toBe(true)
			git(['config', 'filter.subevil.clean', `sh -c 'echo SUBMODULE-CLEAN >> ${marker}; cat'`], sub)
			git(['config', 'filter.subevil.required', 'true'], sub)
			// Same size, new content: git cannot tell it changed from the file's size, so it has
			// to read the file through the clean filter to compare.
			writeFileSync(join(sub, 'a.txt'), 'two\n')

			for (const args of [['add', '-A'], ['status', '--porcelain'], ['diff'], ['commit', '-m', 'nothing staged']]) {
				await runGit(args, { repoPath: superproject, config: ['user.name=T', 'user.email=t@e'] })
			}
			expect(readMarker(marker)).toBe('')

			// Control: plain `git add -A` in the superproject checks the submodule for changes
			// with a git of its own, which runs the submodule's filter.
			writeFileSync(join(sub, 'a.txt'), 'six\n')
			git(['add', '-A'], superproject)
			expect(readMarker(marker)).toContain('SUBMODULE-CLEAN')
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

	test('a repository that rewrites or re-routes the remote URL is refused before git contacts anything', async () => {
		const { runGit, GitRefusedError } = await import('../src/lib/source-control/git-exec.server')
		const tmp = makeTempDir('git-exec-redirect')
		const server = await startGitHttpServer(tmp.path)
		try {
			createUpstream(tmp.path)
			createUpstream(tmp.path, 'decoy.git')
			const url = `${server.origin}/upstream.git`
			const decoy = `${server.origin}/decoy.git`
			const victim = join(tmp.path, 'victim.txt')
			const redirects: Array<[string, string]> = [
				[`url.${decoy}.insteadOf`, url],
				[`url.${decoy}.pushInsteadOf`, url],
				[`remote.${url}.url`, decoy],
				[`remote.${url}.mirror`, 'true'],
				[`http.${url}.sslCAInfo`, slash(victim)],
				[`http.${server.origin}/.cookieFile`, slash(victim)],
			]
			for (const [i, [key, value]] of redirects.entries()) {
				const repo = join(tmp.path, `repo-${i}`)
				git(['init', '-q', '-b', 'main', repo])
				git(['config', key, value], repo)
				for (const args of [['ls-remote', url], ['fetch', url, '+refs/heads/*:refs/remotes/origin/*'], ['push', url, 'HEAD:refs/heads/x']]) {
					await expect(runGit(args, { repoPath: repo, remote: { url, token: 'tok-456' } })).rejects.toBeInstanceOf(
						GitRefusedError,
					)
				}
			}
			expect(server.requests).toEqual([])

			// Control: plain git follows the rewrite to the decoy.
			const control = join(tmp.path, 'repo-0')
			await gitAsync(['ls-remote', url], control)
			expect(server.requests.some((r) => r.url.startsWith('/decoy.git'))).toBe(true)
		} finally {
			await server.close()
			tmp.cleanup()
		}
	})

	test('unscoped proxy and cookie-jar settings in the repository lose to the URL-scoped pins', async () => {
		const { runGit } = await import('../src/lib/source-control/git-exec.server')
		const tmp = makeTempDir('git-exec-pins')
		const server = await startGitHttpServer(tmp.path)
		const sink = await startRecordingSink()
		try {
			createUpstream(tmp.path)
			const url = `${server.origin}/upstream.git`
			const victim = join(tmp.path, 'victim.txt')
			writeFileSync(victim, 'precious\n')
			const repo = join(tmp.path, 'repo')
			git(['init', '-b', 'main', repo])
			git(['config', 'http.proxy', sink.origin], repo)
			git(['config', 'http.cookieFile', slash(victim)], repo)
			git(['config', 'http.saveCookies', 'true'], repo)

			const res = await runGit(['ls-remote', url], { repoPath: repo, remote: { url, token: 'tok-789' } })
			expect(res.code).toBe(0)
			expect(sink.hits).toEqual([])
			expect(readFileSync(victim, 'utf8')).toBe('precious\n')

			// Control: plain git sends the request through the proxy, and a direct call writes a
			// cookie jar over the victim file.
			await gitAsync(['ls-remote', url], repo)
			expect(sink.hits.length).toBeGreaterThan(0)
			git(['config', '--unset', 'http.proxy'], repo)
			await gitAsync(['ls-remote', url], repo)
			expect(readFileSync(victim, 'utf8')).not.toBe('precious\n')
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
			expect(readMarker(marker)).toBe('')

			// Control: on the same 401, plain git asks the repository's helper for credentials.
			await gitAsync(['ls-remote', url], repo)
			expect(readMarker(marker)).toMatch(/HELPER|ASKPASS/)
		} finally {
			await server.close()
			tmp.cleanup()
		}
	})

	test('another transport is refused, whether a rewrite or the URL itself asks for it', async () => {
		const { runGit, GitRefusedError } = await import('../src/lib/source-control/git-exec.server')
		const tmp = makeTempDir('git-exec-protocol')
		try {
			const bare = createUpstream(tmp.path)
			const url = 'https://github.com/acme/widgets.git'
			const repo = join(tmp.path, 'repo')
			git(['init', '-b', 'main', repo])
			git(['config', `url.file://${slash(bare)}.insteadOf`, url], repo)
			git(['config', 'protocol.file.allow', 'always'], repo)

			// The rewrite never reaches git.
			await expect(runGit(['fetch', url], { repoPath: repo, remote: { url, token: 'tok' } })).rejects.toBeInstanceOf(
				GitRefusedError,
			)
			// And with no repository config in play, the protocol allowlist still says no.
			const fileUrl = `file://${slash(bare)}`
			const res = await runGit(['ls-remote', fileUrl], { cwd: tmp.path, remote: { url: fileUrl } })
			expect(res.code).not.toBe(0)
			expect(res.stderr).toMatch(/not allowed/)
		} finally {
			tmp.cleanup()
		}
	})
})
