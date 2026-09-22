import { defineConfig, devices } from '@playwright/test'
import { QUARANTINE } from './tests/quarantine'

/**
 * Playwright config — runs every spec twice (desktop + mobile) by default so
 * mobile-specific layout regressions surface in the same run as functional
 * failures. The `tests/crud/mobile/*` specs are mobile-only via per-spec skip
 * conditions; everything else runs in both projects.
 *
 * To run a single project: `--project=desktop` or `--project=mobile`.
 */
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
		baseURL: 'http://127.0.0.1:4173',
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
		command: 'bun run dev --host 127.0.0.1 --port 4173',
		env: {
			...process.env,
			E2E_MOCK_EXTERNALS: '0',
			// The suite exercises the login redirect and the unauthenticated posture of
			// public routes. `AUTH_DEV_BYPASS=1` in a developer's .env attaches every
			// request to the singleton user, so those specs can never fail honestly — and
			// several were failing because of it. Force it off for the test server; a
			// developer's own dev server is unaffected.
			AUTH_DEV_BYPASS: '0',
			// Default values for env vars that gate test coverage. Operators can override
			// via .env or the shell env to point at real services. The webhook secret here
			// is a test-only constant so the webhook endpoint tests always run end-to-end.
			GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET ?? 'e2e-test-webhook-secret-do-not-use-in-prod',
		},
		/**
		 * Wait for a real response, not just an open socket.
		 *
		 * `port` is satisfied the moment Vite binds, which happens about 22 seconds before
		 * the dev server can actually serve a page — Vite compiles on demand. Playwright
		 * would start running while the app was still cold, and the first specs to touch a
		 * page burned their 30s timeout waiting for a first compile that had not finished.
		 * That produced timeout-shaped failures scattered across UI specs, moving between
		 * runs depending on which file got there first.
		 *
		 * `/api/health` is unauthenticated (PUBLIC_PATH_PREFIXES) and touches the database,
		 * so a 200 from it means the whole stack is genuinely up.
		 */
		url: 'http://127.0.0.1:4173/api/health',
		timeout: 180_000,
		/**
		 * Reuse is convenient locally but it is a footgun worth naming: a dev server you
		 * started yourself does not carry the env below, so the suite silently tests a
		 * differently-configured app. A stray `bun run dev` on 4173 without
		 * GITHUB_WEBHOOK_SECRET turns 12 webhook specs into 503s that look like real
		 * failures. If results look wrong, kill whatever is on 4173 and re-run.
		 */
		reuseExistingServer: true,
	},
})
