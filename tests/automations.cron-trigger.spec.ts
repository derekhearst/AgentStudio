import { expect, test } from '@playwright/test'
import { hasCronAccess } from '../src/lib/automations/cron-trigger'
import { testServerEnv } from './server-env'

/**
 * `POST /api/cron` — the external trigger actually triggers.
 *
 * The route documented a bearer secret for external schedulers, but `/api/cron` was not a
 * public path, so the hook answered every cookieless request `303 → /login` before the
 * secret was ever read. An operator who pointed a cron at it exactly as documented got a
 * redirect on every tick and no error anywhere. The existing specs could not notice: they
 * all fire the route with a session cookie.
 *
 * Every HTTP case uses `maxRedirects: 0`. A followed 303 lands on /login, which answers 200,
 * and that is precisely how a broken trigger looked like a working one.
 */

const SECRET = 'correct-horse-battery-staple'

test.describe('automations/cron-trigger — who may fire the tick', () => {
	test('a signed-in session may, with or without a secret configured', () => {
		expect(hasCronAccess({ authenticated: true, authorization: null, secret: undefined })).toBe(true)
		expect(hasCronAccess({ authenticated: true, authorization: null, secret: SECRET })).toBe(true)
	})

	test('a caller with no session needs the configured secret as a bearer token', () => {
		expect(hasCronAccess({ authenticated: false, authorization: `Bearer ${SECRET}`, secret: SECRET })).toBe(true)
		expect(hasCronAccess({ authenticated: false, authorization: `bearer   ${SECRET}  `, secret: SECRET })).toBe(true)
		expect(hasCronAccess({ authenticated: false, authorization: 'Bearer wrong', secret: SECRET })).toBe(false)
		expect(hasCronAccess({ authenticated: false, authorization: `Bearer ${SECRET}x`, secret: SECRET })).toBe(false)
		expect(hasCronAccess({ authenticated: false, authorization: SECRET, secret: SECRET })).toBe(false)
		expect(hasCronAccess({ authenticated: false, authorization: null, secret: SECRET })).toBe(false)
	})

	test('with no secret configured, nobody without a session gets in — the old code let everyone', () => {
		// The path is public now, so failing open here would make the tick anonymous.
		expect(hasCronAccess({ authenticated: false, authorization: null, secret: undefined })).toBe(false)
		expect(hasCronAccess({ authenticated: false, authorization: 'Bearer anything', secret: undefined })).toBe(false)
	})
})

test.describe('automations/cron-trigger — over HTTP, with no cookie', () => {
	test('no credential is a 401, not a redirect to the login page', async ({ request }) => {
		const response = await request.post('/api/cron', { maxRedirects: 0 })
		expect(response.status()).toBe(401)
		expect(await response.json()).toEqual({ error: 'Unauthorized' })
	})

	test('a wrong bearer is a 401', async ({ request }) => {
		const response = await request.post('/api/cron', {
			headers: { authorization: 'Bearer not-the-secret' },
			maxRedirects: 0,
		})
		expect(response.status()).toBe(401)
	})

	test('the configured bearer runs the tick', async ({ request }) => {
		test.setTimeout(90_000)
		// The secret the test server was started with — tests/server-env.ts sets one. A server
		// you started yourself without `bun run dev:test` will not have it; restart it.
		const secret = testServerEnv().CRON_SECRET
		const response = await request.post('/api/cron', {
			headers: { authorization: `Bearer ${secret}` },
			maxRedirects: 0,
		})
		expect(response.status()).toBe(200)
		const body = (await response.json()) as Record<string, unknown>
		expect(body).toHaveProperty('automations')
		expect(body).toHaveProperty('skillEmbeddings')
	})
})
