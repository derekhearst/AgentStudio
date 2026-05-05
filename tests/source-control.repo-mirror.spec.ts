import { expect, test } from '@playwright/test'

/**
 * Wave 5 #19 phase 2 (mirror slice) — argv-builder + path-bounding contract for
 * `materializeRepoMirror`. Live `git clone` against GitHub is exercised in operator-led
 * E2E and isn't run from this spec; the structural contracts that gate safety
 * (token-never-in-argv, path containment via SAFE_SEGMENT regex, fully-qualified HTTPS
 * URL) are pinned here so a regression on those properties fails fast.
 */

test.describe('source-control/repo-mirror — argv builders', () => {
	test('buildCloneArgs uses the credential helper indirection (token from env, not argv)', async () => {
		const { buildCloneArgs } = await import('../src/lib/source-control/repo-mirror.server')
		const args = buildCloneArgs({
			remoteUrl: 'https://github.com/acme/widgets.git',
			targetPath: '/sandbox/u1/repos/acme/widgets',
		})
		expect(args.join(' ')).not.toContain('GIT_TOKEN')
		expect(args).toContain('credential.helper=!f() { echo "username=x-access-token"; echo "password=$GIT_TOKEN"; }; f')
		expect(args).toContain('https://github.com/acme/widgets.git')
		expect(args).toContain('/sandbox/u1/repos/acme/widgets')
		expect(args).toContain('--no-tags') // we never need tag history for the mirror's purpose
	})

	test('buildFetchArgs targets the existing mirror with -C and uses --prune', async () => {
		const { buildFetchArgs } = await import('../src/lib/source-control/repo-mirror.server')
		const args = buildFetchArgs({
			repoPath: '/sandbox/u1/repos/acme/widgets',
			remoteUrl: 'https://github.com/acme/widgets.git',
		})
		expect(args).toContain('-C')
		expect(args).toContain('/sandbox/u1/repos/acme/widgets')
		expect(args).toContain('fetch')
		expect(args).toContain('--prune')
		expect(args).toContain('https://github.com/acme/widgets.git')
	})
})

test.describe('source-control/repo-mirror — path containment', () => {
	test('buildMirrorPath joins owner + repo under the configured mirror root', async () => {
		const { buildMirrorPath } = await import('../src/lib/source-control/repo-mirror.server')
		const path = buildMirrorPath('/sandbox/u1/repos', 'acme', 'widgets')
		// Don't pin the separator (Windows vs Unix differs); just check the segments are present.
		expect(path).toContain('acme')
		expect(path).toContain('widgets')
		expect(path.startsWith('/sandbox/u1/repos') || path.startsWith('\\sandbox\\u1\\repos')).toBe(true)
	})

	test('hostile owner/repo segments are rejected before any path is built', async () => {
		const { buildMirrorPath } = await import('../src/lib/source-control/repo-mirror.server')
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
		const { buildMirrorPath } = await import('../src/lib/source-control/repo-mirror.server')
		expect(() => buildMirrorPath('/root', 'a.b-c_d', 'repo.name')).not.toThrow()
	})
})
