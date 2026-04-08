import { defineConfig } from '@playwright/test'

export default defineConfig({
	testDir: './tests',
	testMatch: '**/*.spec.ts',
	globalSetup: './tests/global-setup.ts',
	use: {
		baseURL: 'http://127.0.0.1:4173',
		headless: true,
	},
	webServer: {
		command: 'bun run build && bun run preview --host 127.0.0.1 --port 4173',
		env: {
			...process.env,
			E2E_MOCK_EXTERNALS: '0',
		},
		port: 4173,
		reuseExistingServer: true,
	},
})
