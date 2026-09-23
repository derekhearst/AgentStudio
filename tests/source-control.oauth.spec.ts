import { expect, test } from '@playwright/test'
import { authenticateContext } from './helpers'

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

/**
 * `?return=` on the connect route is attacker-controlled (anything can link to it, and a
 * model reply could load it as an image), and the callback redirects to it. Unchecked, the
 * pair was an open redirect that forwarded whatever the URL carried to another site.
 */
test.describe('source-control/github-oauth — the return path cannot leave the app', () => {
	test('safeReturnPath keeps a path on this app and nothing else', async () => {
		const { safeReturnPath } = await import('../src/lib/source-control/github-oauth')

		expect(safeReturnPath('/projects/abc?tab=repos')).toBe('/projects/abc?tab=repos')
		expect(safeReturnPath('/settings')).toBe('/settings')
		expect(safeReturnPath('/a/../b')).toBe('/b')

		for (const hostile of [
			'https://attacker.example/SECRET',
			'//attacker.example/SECRET',
			'/\\attacker.example/SECRET',
			'\\\\attacker.example/SECRET',
			'/\t/attacker.example/SECRET',
			'/\n/attacker.example',
			'/.//attacker.example',
			'/..//attacker.example',
			'javascript:alert(1)',
			'projects',
			' /projects',
			'',
		]) {
			expect(safeReturnPath(hostile), JSON.stringify(hostile)).toBe('/projects')
		}
		expect(safeReturnPath(null)).toBe('/projects')
		expect(safeReturnPath('https://attacker.example', '/source-control')).toBe('/source-control')
	})

	test('the callback does not redirect off-site even when the cookie says to', async ({ page }) => {
		await authenticateContext(page.context())
		const { GITHUB_OAUTH_RETURN_COOKIE } = await import('../src/lib/source-control/github-oauth')
		const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:4173')
		// Planted directly, standing in for a cookie set before this fix or by any other route.
		await page.context().addCookies([
			{
				name: GITHUB_OAUTH_RETURN_COOKIE,
				value: encodeURIComponent('https://attacker.example/SECRET'),
				domain: origin.hostname,
				path: '/source-control/github',
				httpOnly: true,
				sameSite: 'Lax',
				secure: false,
			},
		])

		// No code: the callback fails early, before any GitHub call, and redirects "back".
		const response = await page.request.get('/source-control/github/callback', { maxRedirects: 0 })
		expect(response.status()).toBe(302)
		expect(response.headers()['location']).toBe('/projects?error=missing_code_or_state')
	})

	test('the connect route never stores an off-site return path', async ({ page }) => {
		await authenticateContext(page.context())
		const response = await page.request.get(
			'/source-control/github/connect?return=https://attacker.example/SECRET',
			{ maxRedirects: 0 },
		)
		// Without OAuth credentials the route stops before setting any cookie.
		test.skip(response.status() === 503, 'GitHub OAuth is not configured on this host')
		expect(response.status()).toBe(302)
		const { GITHUB_OAUTH_RETURN_COOKIE } = await import('../src/lib/source-control/github-oauth')
		const stored = (await page.context().cookies()).find((c) => c.name === GITHUB_OAUTH_RETURN_COOKIE)
		expect(decodeURIComponent(stored?.value ?? '')).toBe('/projects')
	})
})
