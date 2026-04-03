import { defineConfig } from '@playwright/test'

const isLiveRun = process.env.PLAYWRIGHT_LIVE === '1'

export default defineConfig({
	testDir: './tests',
	testMatch: '**/*.spec.ts',
	use: {
		baseURL: 'http://127.0.0.1:4173',
		headless: true,
	},
	webServer: {
		command: 'bun run build && bun run preview --host 127.0.0.1 --port 4173',
		env: {
			...process.env,
			E2E_MOCK_EXTERNALS: isLiveRun ? '0' : '1',
		},
		port: 4173,
		reuseExistingServer: true,
	},
})
