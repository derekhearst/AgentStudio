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

test.describe('source-control — where "connect GitHub" messages send the user', () => {
	test('every connection message names a page that exists', async () => {
		const { existsSync } = await import('node:fs')
		const { GITHUB_CONNECT_PAGE, GITHUB_RECONNECT_MESSAGE, githubNotConnectedMessage } = await import(
			'../src/lib/source-control/github-oauth'
		)
		// The standalone /source-control page was deleted; only its OAuth endpoints remain.
		expect(existsSync(`src/routes${GITHUB_CONNECT_PAGE}/+page.svelte`)).toBe(true)
		for (const message of [githubNotConnectedMessage('pushing'), GITHUB_RECONNECT_MESSAGE]) {
			expect(message).toContain(GITHUB_CONNECT_PAGE)
			expect(message).not.toMatch(/\/source-control\b/)
		}
	})
})

/**
 * The `?return=` path is the one piece of the OAuth round trip that comes from a link, and it
 * ends up in a `Location` header. It used to be copied verbatim, which made
 * `/source-control/github/connect?return=https://evil.example` an open redirect: GitHub
 * auto-approves an app the user already authorised, so one click took a signed-in user from
 * this origin to an attacker's page.
 */
test.describe('source-control/github-oauth — the return path stays on this site', () => {
	const FALLBACK = '/projects'

	test('same-origin paths survive with their query and fragment', async () => {
		const { sanitizeOAuthReturnPath } = await import('../src/lib/source-control/github-oauth')
		expect(sanitizeOAuthReturnPath('/projects')).toBe('/projects')
		expect(sanitizeOAuthReturnPath('/projects/abc?tab=git#x')).toBe('/projects/abc?tab=git#x')
		expect(sanitizeOAuthReturnPath('/source-control?x=1')).toBe('/source-control?x=1')
	})

	test('anything that leaves the origin falls back to /projects', async () => {
		const { sanitizeOAuthReturnPath } = await import('../src/lib/source-control/github-oauth')
		for (const hostile of [
			'https://evil.example',
			'http://evil.example/projects',
			'//evil.example',
			'//evil.example/projects',
			'/\\evil.example',
			'\\\\evil.example',
			'javascript:alert(1)',
			'evil.example',
			// Dot segments normalise these into `//evil.example`, which a browser reads as a host.
			'/..//evil.example',
			'/.//evil.example',
			'/%2e%2e//evil.example',
			// Control characters: a raw CR/LF would split the Location header, and a tab is
			// silently dropped by URL parsers, turning `/\t/evil` into `//evil`.
			'/\r\nLocation: https://evil.example',
			'/\t/evil.example',
			'',
			null,
			undefined,
		]) {
			expect(sanitizeOAuthReturnPath(hostile), JSON.stringify(hostile)).toBe(FALLBACK)
		}
	})

	test('a failed round trip reports back to the same path, with only the error in its query', async () => {
		const { oauthFailureLocation } = await import('../src/lib/source-control/github-oauth')
		expect(oauthFailureLocation('/projects/abc?tab=git#x', 'state_mismatch')).toBe('/projects/abc?error=state_mismatch')
		expect(oauthFailureLocation('https://evil.example/phish', 'access_denied')).toBe('/projects?error=access_denied')
		// The reason is GitHub's `?error=` value, so it is encoded rather than trusted.
		expect(oauthFailureLocation('/projects', 'a b&next=//evil')).toBe('/projects?error=a+b%26next%3D%2F%2Fevil')
	})
})

/**
 * The same rule, end to end: the helper above is only as good as the two routes that use it.
 * `?return=` arrives on a GET anything can link to (a model reply could even load it as an
 * image), and the cookie that carries it back is the browser's to change.
 */
test.describe('source-control/github-oauth — the connect and callback routes apply it', () => {
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
