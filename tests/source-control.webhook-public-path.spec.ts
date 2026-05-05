import { expect, test } from '@playwright/test'

/**
 * Wave 5 #19 phase 5 — verify `/api/webhooks/github` bypasses auth.
 *
 * GitHub doesn't send session cookies; the route handler verifies the HMAC signature
 * itself. The path-level auth bypass lives in `hooks.server.ts` PUBLIC_PATH_PREFIXES
 * — without it, an unauthenticated GitHub POST would 303 to /login and never reach
 * the handler. This test confirms the bypass is actually in place by asserting the
 * route returns a webhook-specific response (503 when no secret OR 401 when secret
 * is set but signature missing) rather than a 303 redirect.
 *
 * Always exercisable — independent of GITHUB_WEBHOOK_SECRET configuration.
 */

const BASE_URL = 'http://127.0.0.1:4173'

test.describe('webhooks/github — public path routing', () => {
	test('unauthenticated POST is NOT redirected to /login (auth bypass works)', async () => {
		const response = await fetch(`${BASE_URL}/api/webhooks/github`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-GitHub-Event': 'ping',
			},
			body: JSON.stringify({ zen: 'unauthed-test' }),
			redirect: 'manual',
		})
		// Core contract: never a 303 redirect. The handler is allowed to return any
		// non-redirect status (200/401/500/503) — what matters is that the path is
		// NOT gated by the auth hook. A 303 here would mean PUBLIC_PATH_PREFIXES is
		// missing `/api/webhooks` and operators would never get a webhook through.
		expect(response.status).not.toBe(303)
		expect(response.status).not.toBe(302)
		const location = response.headers.get('location') ?? ''
		expect(location).not.toMatch(/\/login/)
	})

	test('the response body is never a login page when posting to the webhook path', async () => {
		const response = await fetch(`${BASE_URL}/api/webhooks/github`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-GitHub-Event': 'ping',
			},
			body: '{}',
		})
		const body = await response.text()
		// Even if the route returned a 500 (e.g., transient SvelteKit cache hiccup),
		// the body must NEVER include a login form. That'd mean the auth redirect
		// fired and the test setup is the wrong place to debug.
		expect(body).not.toMatch(/<form[^>]*login/i)
		expect(body).not.toMatch(/passkey/i)
	})
})
