/**
 * Start a long-lived dev server configured exactly as Playwright's `webServer` would.
 *
 * Run this once (`bun run dev:test`) and leave it up; every `bunx playwright test` after
 * it reuses the warm server instead of paying ~45s to boot and cold-compile Vite. The
 * whole point is that the env comes from the same `testServerEnv()` the config uses, so
 * reusing it cannot silently change what is under test.
 *
 * Press Ctrl-C to stop it. Kill it before a run you want to be pristine.
 */
import { spawn } from 'node:child_process'
import { TEST_SERVER_HEALTH_URL, TEST_SERVER_PORT, testServerEnv } from '../tests/server-env'

const child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(TEST_SERVER_PORT)], {
	env: testServerEnv(),
	stdio: 'inherit',
	shell: process.platform === 'win32',
})

child.on('exit', (code) => process.exit(code ?? 0))

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		child.kill(signal)
	})
}

// Report readiness on the same signal Playwright waits for, so it is obvious when the
// server is actually usable rather than merely bound to the port.
const startedAt = Date.now()
const waitForHealth = async () => {
	for (;;) {
		try {
			const response = await fetch(TEST_SERVER_HEALTH_URL)
			if (response.ok) {
				console.log(`\n[test-server] ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${TEST_SERVER_HEALTH_URL}`)
				console.log('[test-server] leave this running; playwright will reuse it\n')
				return
			}
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
}
void waitForHealth()
