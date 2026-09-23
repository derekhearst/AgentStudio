import { defineConfig, devices } from '@playwright/test'
import { QUARANTINE } from './tests/quarantine'
import {
	TEST_SERVER_HEALTH_URL,
	TEST_SERVER_ORIGIN,
	TEST_SERVER_PORT,
	noModelCredentialsRequested,
	stripModelCredentials,
	testServerEnv,
} from './tests/server-env'

/**
 * Playwright config — runs every spec twice (desktop + mobile) by default so
 * mobile-specific layout regressions surface in the same run as functional
 * failures. The `tests/crud/mobile/*` specs are mobile-only via per-spec skip
 * conditions; everything else runs in both projects.
 *
 * To run a single project: `--project=desktop` or `--project=mobile`.
 */
/*
 * Keep each Playwright worker's database pool small.
 *
 * This file is loaded by the runner and by every worker, so setting it here reaches all
 * of them. Specs import server modules to call them directly, which opens an app pool
 * per worker; at postgres.js's default of ten that is ~80 connections for eight workers,
 * against a `max_connections` of 100. The suite then failed with "sorry, too many
 * clients already" in whichever spec happened to ask for a connection next.
 *
 * A worker runs one test at a time, so it needs very few. The dev server is given its
 * own, larger value in tests/server-env.ts — it serves all eight workers at once.
 */
process.env.DATABASE_POOL_MAX ??= '3'

/*
 * No job scheduler in the worker processes.
 *
 * Importing a server module boots the database, and the boot starts a job worker and a
 * scheduler — so every Playwright worker process ran its own scheduler beside the dev
 * server's. Now that recurring dispatchers really do run every minute, that was up to nine
 * automation, monitor and PR-watch dispatchers at once, racing specs that seed an automation
 * and drive it themselves. The dev server keeps its scheduler: `webServer.env` below sets it
 * explicitly, because that env is copied from this process. A spec that wants a dispatch
 * calls the dispatcher directly.
 */
process.env.JOBS_SCHEDULER_ENABLED ??= '0'

/*
 * Strip model credentials from the worker processes too, when asked.
 *
 * This file is loaded by the runner and by every worker, which is the only hook that
 * reaches them. It matters because several specs do not go through the dev server at
 * all — they `await import('../src/lib/automations/engine')` and run the model in the
 * worker — so stripping only the server's environment would leave the very spec that
 * motivated this (`automations.output-routing`) still passing locally while failing CI.
 */
if (noModelCredentialsRequested()) {
	stripModelCredentials(process.env as Record<string, string>)
	console.log('[playwright] E2E_NO_MODEL_CREDENTIALS=1 — workers have no model credential')
}

export default defineConfig({
	/**
	 * CI skips the live-model specs and the #55 quarantine; a local run does not, so the
	 * quarantine stays visible to whoever is working through it. Opt-in rather than
	 * opt-out on purpose — a list that silently hides specs everywhere is how the suite
	 * rotted in the first place.
	 */
	// One retry in CI. A test that passes on retry is reported as flaky rather than
	// failing the build, which keeps a real regression legible instead of drowning it in
	// order-dependent noise. Locally there are no retries, so flakes stay annoying enough
	// to get fixed.
	retries: process.env.CI ? 1 : 0,
	testIgnore: process.env.E2E_QUARANTINE === '1' ? [...QUARANTINE] : [],
	testDir: './tests',
	testMatch: '**/*.spec.ts',
	globalSetup: './tests/global-setup.ts',
	use: {
		baseURL: TEST_SERVER_ORIGIN,
		headless: true,
	},
	projects: [
		{
			name: 'desktop',
			use: {
				viewport: { width: 1440, height: 900 },
			},
		},
		{
			name: 'mobile',
			use: {
				// Use Pixel 7 (Chromium) instead of iPhone 14 (Webkit) so we don't need to
				// install webkit in CI. Same mobile semantics: isMobile + hasTouch.
				...devices['Pixel 7'],
				headless: true,
			},
		},
	],
	webServer: {
		command: `bun run dev --host 127.0.0.1 --port ${TEST_SERVER_PORT}`,
		// Shared with `bun run dev:test` so a reused server is configured identically. The
		// scheduler is on by default, so that script's server runs it too.
		env: { ...testServerEnv(), JOBS_SCHEDULER_ENABLED: '1' },
		/**
		 * Wait for a real response, not just an open socket.
		 *
		 * `port` is satisfied the moment Vite binds, which happens about 22 seconds before
		 * the dev server can actually serve a page — Vite compiles on demand. Playwright
		 * would start running while the app was still cold, and the first specs to touch a
		 * page burned their 30s timeout waiting for a first compile that had not finished.
		 * That produced timeout-shaped failures scattered across UI specs, moving between
		 * runs depending on which file got there first.
		 */
		url: TEST_SERVER_HEALTH_URL,
		timeout: 180_000,
		/**
		 * Reuse used to be a footgun: a dev server you started yourself did not carry the
		 * env above, so the suite silently tested a differently-configured app. Start one
		 * with `bun run dev:test` instead — it uses the same `testServerEnv()` — and every
		 * run after it skips the ~45s cold boot. If results still look wrong, kill whatever
		 * is on 4173 and re-run.
		 */
		reuseExistingServer: true,
	},
})
