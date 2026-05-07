import { expect, test } from '@playwright/test'

/**
 * Pure clone-URL parser invariants. The parser is the discriminator the import flow
 * uses to pick a provider, auth method, and credential username, so coverage of the
 * URL forms users actually paste matters.
 */

test.describe('source-control/parse-clone-url — provider detection', () => {
	test('parses GitHub HTTPS URLs in their common shapes', async () => {
		const { parseCloneUrl } = await import('../src/lib/source-control/parse-clone-url')

		const variants = [
			'https://github.com/owner/repo.git',
			'https://github.com/owner/repo',
			'https://github.com/owner/repo/',
			'https://github.com/owner/repo.git/',
			'http://github.com/owner/repo',
			'https://x-access-token:tokentokentoken@github.com/owner/repo.git',
		]

		for (const input of variants) {
			const parsed = parseCloneUrl(input)
			expect(parsed.provider, `failed for ${input}`).toBe('github')
			if (parsed.provider !== 'github') continue
			expect(parsed.owner).toBe('owner')
			expect(parsed.repo).toBe('repo')
			expect(parsed.cloneUrl).toBe('https://github.com/owner/repo.git')
			expect(parsed.htmlUrl).toBe('https://github.com/owner/repo')
		}
	})

	test('parses GitHub SSH URLs', async () => {
		const { parseCloneUrl } = await import('../src/lib/source-control/parse-clone-url')

		for (const input of ['git@github.com:owner/repo.git', 'git@github.com:owner/repo']) {
			const parsed = parseCloneUrl(input)
			expect(parsed.provider, `failed for ${input}`).toBe('github')
			if (parsed.provider !== 'github') continue
			expect(parsed.owner).toBe('owner')
			expect(parsed.repo).toBe('repo')
			expect(parsed.cloneUrl).toBe('https://github.com/owner/repo.git')
		}
	})

	test('parses Azure DevOps dev.azure.com URLs', async () => {
		const { parseCloneUrl } = await import('../src/lib/source-control/parse-clone-url')

		const variants = [
			'https://dev.azure.com/myorg/myproject/_git/myrepo',
			'https://dev.azure.com/myorg/myproject/_git/myrepo.git',
			'https://dev.azure.com/myorg/myproject/_git/myrepo/',
			'https://myorg@dev.azure.com/myorg/myproject/_git/myrepo',
		]

		for (const input of variants) {
			const parsed = parseCloneUrl(input)
			expect(parsed.provider, `failed for ${input}`).toBe('azure_devops')
			if (parsed.provider !== 'azure_devops') continue
			expect(parsed.org).toBe('myorg')
			expect(parsed.project).toBe('myproject')
			expect(parsed.repo).toBe('myrepo')
			expect(parsed.cloneUrl).toBe('https://dev.azure.com/myorg/myproject/_git/myrepo')
			expect(parsed.htmlUrl).toBe('https://dev.azure.com/myorg/myproject/_git/myrepo')
		}
	})

	test('parses Azure DevOps legacy visualstudio.com URLs (with and without DefaultCollection)', async () => {
		const { parseCloneUrl } = await import('../src/lib/source-control/parse-clone-url')

		const variants = [
			'https://myorg.visualstudio.com/myproject/_git/myrepo',
			'https://myorg.visualstudio.com/myproject/_git/myrepo.git',
			'https://myorg.visualstudio.com/DefaultCollection/myproject/_git/myrepo',
			'https://myorg.visualstudio.com/DefaultCollection/myproject/_git/myrepo.git',
		]

		for (const input of variants) {
			const parsed = parseCloneUrl(input)
			expect(parsed.provider, `failed for ${input}`).toBe('azure_devops')
			if (parsed.provider !== 'azure_devops') continue
			expect(parsed.org).toBe('myorg')
			expect(parsed.project).toBe('myproject')
			expect(parsed.repo).toBe('myrepo')
			// legacy URLs are normalized to the dev.azure.com canonical form
			expect(parsed.cloneUrl).toBe('https://dev.azure.com/myorg/myproject/_git/myrepo')
		}
	})

	test('falls back to generic local provider for self-hosted HTTPS URLs', async () => {
		const { parseCloneUrl } = await import('../src/lib/source-control/parse-clone-url')

		const parsed = parseCloneUrl('https://git.example.com/team/project.git')
		expect(parsed.provider).toBe('local')
		if (parsed.provider !== 'local') return
		expect(parsed.host).toBe('git.example.com')
		expect(parsed.name).toBe('project')
		expect(parsed.owner).toBe('team')
		expect(parsed.cloneUrl).toBe('https://git.example.com/team/project.git')
	})

	test('generic fallback handles single-segment paths by using host as owner', async () => {
		const { parseCloneUrl } = await import('../src/lib/source-control/parse-clone-url')

		const parsed = parseCloneUrl('https://gitea.example.com/standalone-repo')
		expect(parsed.provider).toBe('local')
		if (parsed.provider !== 'local') return
		expect(parsed.host).toBe('gitea.example.com')
		expect(parsed.owner).toBe('gitea.example.com')
		expect(parsed.name).toBe('standalone-repo')
	})

	test('generic fallback joins multi-segment paths into a single owner string', async () => {
		const { parseCloneUrl } = await import('../src/lib/source-control/parse-clone-url')

		const parsed = parseCloneUrl('https://git.example.com/group/subgroup/project.git')
		expect(parsed.provider).toBe('local')
		if (parsed.provider !== 'local') return
		expect(parsed.owner).toBe('group-subgroup')
		expect(parsed.name).toBe('project')
	})

	test('trims surrounding whitespace before parsing', async () => {
		const { parseCloneUrl } = await import('../src/lib/source-control/parse-clone-url')

		const parsed = parseCloneUrl('   https://github.com/owner/repo.git   ')
		expect(parsed.provider).toBe('github')
	})

	test('throws on empty or whitespace-only input', async () => {
		const { parseCloneUrl } = await import('../src/lib/source-control/parse-clone-url')

		expect(() => parseCloneUrl('')).toThrow(/Empty clone URL/)
		expect(() => parseCloneUrl('   ')).toThrow(/Empty clone URL/)
	})

	test('throws on non-URL garbage that does not match the generic HTTPS shape', async () => {
		const { parseCloneUrl } = await import('../src/lib/source-control/parse-clone-url')

		expect(() => parseCloneUrl('not-a-url')).toThrow(/Unsupported clone URL/)
		expect(() => parseCloneUrl('ftp://example.com/repo')).toThrow(/Unsupported clone URL/)
	})

	test('Azure DevOps SSH URLs are not matched (parser only supports HTTPS for Azure)', async () => {
		const { parseCloneUrl } = await import('../src/lib/source-control/parse-clone-url')

		// The parser intentionally does not support Azure SSH because the OAuth flow
		// hands out HTTPS tokens; an SSH URL would have no usable credential path.
		expect(() => parseCloneUrl('git@ssh.dev.azure.com:v3/myorg/myproject/myrepo')).toThrow(
			/Unsupported clone URL/,
		)
	})
})

test.describe('source-control/parse-clone-url — credential helper username', () => {
	test('returns the right credential username for each provider', async () => {
		const { credentialUsernameForProvider } = await import(
			'../src/lib/source-control/parse-clone-url'
		)

		expect(credentialUsernameForProvider('github')).toBe('x-access-token')
		expect(credentialUsernameForProvider('azure_devops')).toBe('oauth2')
		expect(credentialUsernameForProvider('local')).toBe('')
		expect(credentialUsernameForProvider('gitlab')).toBe('')
		expect(credentialUsernameForProvider('unknown')).toBe('')
	})
})

test.describe('source-control/parse-clone-url — mirror owner/name', () => {
	test('uses owner+repo for GitHub repos', async () => {
		const { parseCloneUrl, mirrorOwnerName } = await import(
			'../src/lib/source-control/parse-clone-url'
		)

		const parsed = parseCloneUrl('https://github.com/anthropics/claude-code.git')
		expect(mirrorOwnerName(parsed)).toEqual({ owner: 'anthropics', name: 'claude-code' })
	})

	test('uses org+repo (drops project segment) for Azure DevOps repos', async () => {
		const { parseCloneUrl, mirrorOwnerName } = await import(
			'../src/lib/source-control/parse-clone-url'
		)

		const parsed = parseCloneUrl('https://dev.azure.com/myorg/myproject/_git/myrepo')
		expect(mirrorOwnerName(parsed)).toEqual({ owner: 'myorg', name: 'myrepo' })
	})

	test('uses owner+name for generic local repos', async () => {
		const { parseCloneUrl, mirrorOwnerName } = await import(
			'../src/lib/source-control/parse-clone-url'
		)

		const parsed = parseCloneUrl('https://git.example.com/team/project.git')
		expect(mirrorOwnerName(parsed)).toEqual({ owner: 'team', name: 'project' })
	})
})
