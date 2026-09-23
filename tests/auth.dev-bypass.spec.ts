import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { authDevBypassEnabled } from '../src/lib/auth/dev-bypass'

/**
 * AUTH_DEV_BYPASS cannot be switched on in a production build.
 *
 * `.env.example` promised the bypass was "hard-disabled in production builds". It was gated on
 * `process.env.NODE_ENV` at runtime, which Vite leaves in a server bundle as-is, so only the
 * Dockerfile's `ENV NODE_ENV=production` kept it off. `bun build/index.js` from a checkout —
 * where Bun loads the developer's `.env` automatically — attached every anonymous request on
 * the network to the owner. The gate is SvelteKit's build-time `dev` flag now.
 */

test.describe('auth/dev-bypass — the rule', () => {
	test('a production build ignores the variable, whatever NODE_ENV says', () => {
		expect(authDevBypassEnabled({ devBuild: false, env: { AUTH_DEV_BYPASS: '1' } })).toBe(false)
		expect(authDevBypassEnabled({ devBuild: false, env: { AUTH_DEV_BYPASS: '1', NODE_ENV: 'development' } })).toBe(false)
	})

	test('a dev build honours it, unless NODE_ENV says production or the value is not 1', () => {
		expect(authDevBypassEnabled({ devBuild: true, env: { AUTH_DEV_BYPASS: '1' } })).toBe(true)
		expect(authDevBypassEnabled({ devBuild: true, env: { AUTH_DEV_BYPASS: '1', NODE_ENV: 'production' } })).toBe(false)
		expect(authDevBypassEnabled({ devBuild: true, env: { AUTH_DEV_BYPASS: '0' } })).toBe(false)
		expect(authDevBypassEnabled({ devBuild: true, env: { AUTH_DEV_BYPASS: 'true' } })).toBe(false)
		expect(authDevBypassEnabled({ devBuild: true, env: {} })).toBe(false)
	})

	test('the hook feeds it the build-time flag, not a runtime guess', () => {
		// The rule is only as good as its input: passing `process.env.NODE_ENV !== 'production'`
		// as `devBuild` would reintroduce the bug with every test above still green.
		const hook = readFileSync(join(process.cwd(), 'src/hooks.server.ts'), 'utf8')
		expect(hook).toMatch(/import \{ dev \} from '\$app\/environment'/)
		expect(hook).toMatch(/authDevBypassEnabled\(\{ devBuild: dev, env: process\.env \}\)/)
	})
})
