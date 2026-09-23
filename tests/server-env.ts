import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Set this to `1` to run as CI does: with no model credential anywhere.
 *
 * A developer machine has a working Claude session and a real OPENROUTER_API_KEY; CI has
 * a placeholder and nothing else. That difference is invisible until it isn't — a spec
 * that quietly depends on a model answering passes here and fails there, which is how
 * `automations.output-routing` came off the quarantine on a green local run and then
 * failed CI with `UnauthorizedResponseError`.
 *
 * Honoured in two places, because both need it:
 *   - here, for the dev server (`bun run dev:test:nocreds`)
 *   - in playwright.config.ts, for the worker processes — several specs import
 *     `automations/engine` and run the model in-process, so stripping only the server
 *     would leave exactly the spec that prompted this still passing.
 */
export const NO_MODEL_CREDENTIALS_FLAG = 'E2E_NO_MODEL_CREDENTIALS'

export function noModelCredentialsRequested(base: NodeJS.ProcessEnv = process.env): boolean {
	return base[NO_MODEL_CREDENTIALS_FLAG] === '1'
}

/**
 * Remove every way the process could reach a model, in place.
 *
 * `OPENROUTER_API_KEY` gets CI's placeholder rather than being deleted, because
 * `global-setup` requires it to be *set* — an unset key fails the run for the wrong
 * reason, and a placeholder reproduces CI's 401 exactly.
 *
 * Everything `ANTHROPIC_*` and `CLAUDE_*` is dropped, and `CLAUDE_CONFIG_DIR` is pointed
 * at an empty directory. That last one matters most and is the least obvious: the Agent
 * SDK inherits `process.env` and otherwise authenticates the way Claude Code does, by
 * reading the logged-in session from the config directory. Clearing the variables alone
 * leaves that file, and the run stays authenticated.
 *
 * Dropping by prefix rather than by name on purpose. The SDK bundle reads
 * ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL and CLAUDE_CONFIG_DIR
 * today, and a list of four names is a list that goes stale.
 */
export function stripModelCredentials(env: Record<string, string>): Record<string, string> {
	for (const key of Object.keys(env)) {
		if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_')) delete env[key]
	}

	// Matches `OPENROUTER_API_KEY` in .github/workflows/test.yml.
	env.OPENROUTER_API_KEY = 'ci-placeholder-unused'

	// An empty directory, so the SDK finds no stored session to fall back on.
	const configDir = join(tmpdir(), 'agentstudio-e2e-no-credentials')
	mkdirSync(configDir, { recursive: true })
	env.CLAUDE_CONFIG_DIR = configDir

	// CI sets neither, so the gateway path must be unconfigured here too — otherwise a
	// non-Claude model would still have a route out.
	delete env.LLM_GATEWAY_URL
	delete env.LLM_GATEWAY_TOKEN

	env[NO_MODEL_CREDENTIALS_FLAG] = '1'
	return env
}

/** The `/api/cron` bearer secret the test server runs with, unless the environment sets one. */
export const E2E_CRON_SECRET = 'e2e-test-cron-secret-do-not-use-in-prod'

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
	// Same idea for the external cron trigger, so its bearer path is tested end-to-end.
	env.CRON_SECRET = base.CRON_SECRET ?? E2E_CRON_SECRET

	// The dev server gets a normal pool, explicitly.
	//
	// playwright.config.ts sets `DATABASE_POOL_MAX` on the runner process so each of the
	// eight workers opens a small pool, and this function copies `process.env` — so
	// without this line the server inherited the *worker* value and served the entire
	// suite through two connections. That throttled everything and looked like 171
	// unrelated test failures.
	env.DATABASE_POOL_MAX = base.DATABASE_SERVER_POOL_MAX ?? '10'

	// A throwaway VAPID keypair, generated for this file and used nowhere else. Without
	// one the push-subscription UI cannot work at all — `getPushPublicKey()` throws — so
	// the settings push controls were untestable. Nothing is ever delivered: the specs
	// mock `navigator.serviceWorker`, and the endpoints they subscribe to are fictional.
	env.VAPID_PUBLIC_KEY =
		base.VAPID_PUBLIC_KEY ?? 'BA_iSNjg3ABABHdURp9GyGzD147naGotsGt_5CxFF1DB18GQj2CdVmxxnqSi3Uh8wFDGzltLDofEGABpe27ishM'
	env.VAPID_PRIVATE_KEY = base.VAPID_PRIVATE_KEY ?? 'LxwuKonRPEoB7nvtm1w4m0DlZc2gxd8bk_nIAEu-n8I'

	if (noModelCredentialsRequested(base)) stripModelCredentials(env)

	return env
}

export const TEST_SERVER_PORT = 4173
export const TEST_SERVER_ORIGIN = `http://127.0.0.1:${TEST_SERVER_PORT}`
/** Unauthenticated and database-backed, so a 200 means the whole stack is genuinely up. */
export const TEST_SERVER_HEALTH_URL = `${TEST_SERVER_ORIGIN}/api/health`
