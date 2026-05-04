import { expect, test } from '@playwright/test'

/**
 * Wave 5 #19 phase 2 — GitHub OAuth helper invariants.
 *
 * Pure helpers around URL construction + state generation. The actual code↔token exchange
 * hits github.com which is out of scope for these tests; that path is covered by manual
 * E2E once an OAuth app is registered.
 */

test.describe('source-control/github-oauth — pure helpers', () => {
	test('buildAuthorizeUrl includes client_id, state, scopes, redirect_uri', async () => {
		const { buildAuthorizeUrl } = await import('../src/lib/source-control/github-oauth')
		const url = buildAuthorizeUrl({
			clientId: 'abc123',
			redirectUri: 'https://example.com/cb',
			state: 'state-xyz',
			scopes: ['repo', 'read:user'],
		})
		expect(url).toContain('https://github.com/login/oauth/authorize')
		expect(url).toContain('client_id=abc123')
		expect(url).toContain('state=state-xyz')
		expect(url).toContain('scope=repo+read%3Auser')
		expect(url).toContain(`redirect_uri=${encodeURIComponent('https://example.com/cb')}`)
	})

	test('buildAuthorizeUrl uses default scopes when none provided', async () => {
		const { buildAuthorizeUrl, GITHUB_DEFAULT_SCOPES } = await import('../src/lib/source-control/github-oauth')
		const url = buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://x', state: 's' })
		for (const scope of GITHUB_DEFAULT_SCOPES) {
			expect(url).toContain(encodeURIComponent(scope))
		}
	})

	test('generateOAuthState returns a random base64url string each call', async () => {
		const { generateOAuthState } = await import('../src/lib/source-control/github-oauth')
		const a = generateOAuthState()
		const b = generateOAuthState()
		expect(a).not.toBe(b)
		// base64url alphabet: A-Z a-z 0-9 _ -
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
		expect(a.length).toBeGreaterThanOrEqual(20)
	})

	test('buildCallbackUriFromOrigin trims trailing slash from origin', async () => {
		const { buildCallbackUriFromOrigin } = await import('../src/lib/source-control/github-oauth')
		const result = buildCallbackUriFromOrigin('https://example.com/')
		expect(result).toMatch(/^https:\/\/example\.com\/source-control\/github\/callback$/)
	})

	test('cookie names are stable across the OAuth flow', async () => {
		const { GITHUB_OAUTH_STATE_COOKIE, GITHUB_OAUTH_RETURN_COOKIE } = await import(
			'../src/lib/source-control/github-oauth'
		)
		expect(GITHUB_OAUTH_STATE_COOKIE).toBe('AgentStudio_github_oauth_state')
		expect(GITHUB_OAUTH_RETURN_COOKIE).toBe('AgentStudio_github_oauth_return')
	})
})
