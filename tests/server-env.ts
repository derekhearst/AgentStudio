/**
 * The environment the test dev server must run with.
 *
 * This exists so `reuseExistingServer` stops being a footgun. Playwright will happily
 * adopt whatever is already listening on 4173, but a `bun run dev` you started yourself
 * does not carry these overrides — the suite then tests a differently-configured app and
 * reports failures that have nothing to do with the code. That has cost two debugging
 * sessions: a stray server without `GITHUB_WEBHOOK_SECRET` turned 12 webhook specs into
 * 503s, and one with `AUTH_DEV_BYPASS=1` made the auth-posture specs unable to fail.
 *
 * With one shared definition, `bun run dev:test` starts a server that is byte-identical
 * in configuration to the one Playwright would have started, so a warm server can be
 * reused across many `playwright test` invocations. That turns a ~55s run into a ~12s
 * one, which matters a lot when working through a quarantine spec by spec.
 */
export function testServerEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {}
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined) env[key] = value
	}

	env.E2E_MOCK_EXTERNALS = '0'
	// The suite exercises the login redirect and the unauthenticated posture of public
	// routes. `AUTH_DEV_BYPASS=1` in a developer's .env attaches every request to the
	// singleton user, so those specs can never fail honestly. Force it off for the test
	// server; a developer's own dev server is unaffected.
	env.AUTH_DEV_BYPASS = '0'
	// A test-only constant so the webhook endpoint tests always run end-to-end. Operators
	// can override via .env or the shell env to point at a real secret.
	env.GITHUB_WEBHOOK_SECRET = base.GITHUB_WEBHOOK_SECRET ?? 'e2e-test-webhook-secret-do-not-use-in-prod'

	// A throwaway VAPID keypair, generated for this file and used nowhere else. Without
	// one the push-subscription UI cannot work at all — `getPushPublicKey()` throws — so
	// the settings push controls were untestable. Nothing is ever delivered: the specs
	// mock `navigator.serviceWorker`, and the endpoints they subscribe to are fictional.
	env.VAPID_PUBLIC_KEY =
		base.VAPID_PUBLIC_KEY ?? 'BA_iSNjg3ABABHdURp9GyGzD147naGotsGt_5CxFF1DB18GQj2CdVmxxnqSi3Uh8wFDGzltLDofEGABpe27ishM'
	env.VAPID_PRIVATE_KEY = base.VAPID_PRIVATE_KEY ?? 'LxwuKonRPEoB7nvtm1w4m0DlZc2gxd8bk_nIAEu-n8I'

	return env
}

export const TEST_SERVER_PORT = 4173
export const TEST_SERVER_ORIGIN = `http://127.0.0.1:${TEST_SERVER_PORT}`
/** Unauthenticated and database-backed, so a 200 means the whole stack is genuinely up. */
export const TEST_SERVER_HEALTH_URL = `${TEST_SERVER_ORIGIN}/api/health`
