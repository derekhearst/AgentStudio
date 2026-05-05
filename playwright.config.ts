import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config — runs every spec twice (desktop + mobile) by default so
 * mobile-specific layout regressions surface in the same run as functional
 * failures. The `tests/crud/mobile/*` specs are mobile-only via per-spec skip
 * conditions; everything else runs in both projects.
 *
 * To run a single project: `--project=desktop` or `--project=mobile`.
 */
export default defineConfig({
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
			// Default values for env vars that gate test coverage. Operators can override
			// via .env or the shell env to point at real services. The webhook secret here
			// is a test-only constant so the webhook endpoint tests always run end-to-end.
			GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET ?? 'e2e-test-webhook-secret-do-not-use-in-prod',
		},
		port: 4173,
		reuseExistingServer: true,
	},
})
